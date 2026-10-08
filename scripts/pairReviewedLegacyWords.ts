import * as dotenv from "dotenv";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BSON, MongoClient, ObjectId, type ClientSession, type Db, type Document } from "mongodb";
import { DEFAULT_OPTIONS, initialScheduler } from "../src/features/progress/scheduler.js";
import type { UserProgress } from "../src/features/progress/progress.types.js";
import type { Word } from "../src/features/words/words.types.js";
import { FileWordCardJournal, WordCardMigrationError, sameWordCardBson, serializeWordCardEjson, validateWordCardManifest, wordCardSHA256, type MigrationJournal, type MigrationMode, type WordCardManifest } from "./lib/wordCardMigration.js";

export interface ReviewedLegacyPair {
  parentBefore: Document;
  parentCard: Document;
  recognition: Document;
  sourceRelation: { _id: ObjectId; main: ObjectId; translated: ObjectId; study: Document };
  parentRestSHA256: string;
}
export interface ReviewedLegacyBackup { version: 1; preparedAt: Date; targetSHA256: string; pairs: ReviewedLegacyPair[] }
export interface PairResult { mode: MigrationMode; selected: number; changed: number; already: number; conflicts: number; complete: boolean }
class PairConflict extends Error {}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const error = (message: string): never => { throw new WordCardMigrationError(message); };
const number = (value: unknown) => typeof value === "number" ? value : value instanceof BSON.Int32 || value instanceof BSON.Long || value instanceof BSON.Double ? Number(value.valueOf()) : NaN;
const digestRest = (progress: Document) => wordCardSHA256(serializeWordCardEjson(Object.fromEntries(Object.entries(progress).filter(([key]) => key !== "card"))));
const afterParent = (pair: ReviewedLegacyPair) => ({ ...pair.parentBefore, card: pair.parentCard });

function completeNewScheduler(progress: Document) {
  const scheduler = progress.scheduler;
  if (!scheduler || scheduler.phase !== "NEW" || number(scheduler.version) !== 1 || !scheduler.options || typeof scheduler.timeZone !== "string" || !scheduler.timeZone || !Number.isFinite(number(scheduler.rollover))) error("Selected parent requires a complete stored NEW scheduler");
  for (const [key, sample] of Object.entries(DEFAULT_OPTIONS)) {
    const value = scheduler.options[key];
    if (Array.isArray(sample) ? !Array.isArray(value) || value.some(item => !Number.isFinite(number(item)) || number(item) < 0) : typeof sample === "boolean" ? typeof value !== "boolean" : !Number.isFinite(number(value))) error("Selected parent has incomplete scheduler options");
  }
  if (number(scheduler.options.initialEase) <= 0 || number(scheduler.rollover) < 0 || number(scheduler.rollover) > 23 || !["NEW", "MINUTE", "DAY"].includes(scheduler.queue)) error("Selected parent has invalid scheduler configuration");
  for (const field of ["ease", "interval", "repetitions"]) if (!Number.isFinite(number(progress[field]))) error("Selected parent has invalid stored schedule fields");
  if (!(progress.nextDueDate instanceof Date) || !Number.isFinite(progress.nextDueDate.getTime())) error("Selected parent has invalid stored due date");
}
function contentManifest(pair: ReviewedLegacyPair): WordCardManifest {
  return { version: 1, auditedAt: new Date(), snapshotSHA256: "0".repeat(64), patches: [
    { collection: "userprogresses", id: pair.parentBefore._id.toHexString(), set: { card: pair.parentCard }, unset: [], before: {}, missingBefore: ["card"] },
    { collection: "WORDS_ES_DE", id: pair.sourceRelation._id.toHexString(), set: { study: pair.sourceRelation.study }, unset: [], before: {}, missingBefore: ["study"] },
  ], inserts: [] };
}
function verifyPairIdentity(pair: ReviewedLegacyPair, preparedAt: Date) {
  const parent = pair.parentBefore, source = pair.sourceRelation, content = source.study;
  if (!(parent.userId instanceof ObjectId) || !(parent.itemId instanceof ObjectId) || (parent.relationId && !(parent.relationId instanceof ObjectId)) || !(source.main instanceof ObjectId) || !(source.translated instanceof ObjectId) || !source._id.equals(parent.relationId ?? parent.itemId) || Object.keys(source).some(key => !["_id", "main", "translated", "study"].includes(key))) error("Invalid backed-up source identity");
  const relationId = parent.relationId ?? parent.itemId;
  const seed = (value: ObjectId) => BigInt(`0x${wordCardSHA256(value.toHexString()).slice(0, 15)}`).toString();
  const card = { source: "APP", sourceNoteGuid: `app-word:${parent.userId}:${relationId}`, notes: content.notes, examples: content.examples, deck: "App", tags: [], sourceCardId: seed(parent.itemId), direction: "ES_DE", prompt: content.spanish, answer: content.german, acceptedAnswers: [content.german] };
  if (!sameWordCardBson(pair.parentCard, card)) error("Backed-up production card disagrees with reviewed content or source identity");
  const readingId = new ObjectId(wordCardSHA256(`word-recognition:${parent.userId}:${relationId}`).slice(0, 24));
  const reading: Document = { _id: readingId, userId: parent.userId, itemId: readingId, itemType: "WORD", relationId,
    card: { ...card, sourceCardId: seed(readingId), direction: "DE_ES", prompt: content.german, answer: content.spanish, acceptedAnswers: [content.spanish.replace(/(?:\s+\((?:rflxv\.|formal)\))+$/u, "")] },
    failureIndex: 0, totalReviews: 0, lapses: 0, isNew: true, ease: parent.scheduler.options.initialEase, interval: 0, repetitions: 0, nextDueDate: parent.nextDueDate, lastReviewed: null, createdAt: preparedAt,
  };
  reading.scheduler = initialScheduler(reading as UserProgress, parent.scheduler.options, parent.scheduler.timeZone, parent.scheduler.rollover);
  if (!sameWordCardBson(pair.recognition, reading)) error("Backed-up recognition content or initial schedule disagrees with the native pair contract");
}

/** Uses the app's pure native-pair builder; stores only its production card. */
export async function planReviewedLegacyPair(parent: Document, relation: Document, spanish: Document, german: Document, preparedAt = new Date()): Promise<ReviewedLegacyPair> {
  if (!(parent._id instanceof ObjectId) || !(parent.userId instanceof ObjectId) || !(parent.itemId instanceof ObjectId) || (parent.relationId && !(parent.relationId instanceof ObjectId)) || parent.itemType !== "WORD" || own(parent, "card") || parent.suspended || parent.supersededByAnki) error("Selected parent is not an eligible legacy word without a card");
  completeNewScheduler(parent);
  const relationId = parent.relationId ?? parent.itemId;
  if (!(relation._id instanceof ObjectId) || !relation._id.equals(relationId) || !(relation.main instanceof ObjectId) || !(relation.translated instanceof ObjectId) || !(spanish._id instanceof ObjectId) || !spanish._id.equals(relation.main) || !(german._id instanceof ObjectId) || !german._id.equals(relation.translated) || typeof spanish.word !== "string" || !spanish.word.trim() || typeof german.word !== "string" || !german.word.trim()) error("Selected parent has missing or mismatched vocabulary endpoints");
  if (!(preparedAt instanceof Date) || !Number.isFinite(preparedAt.getTime())) error("Invalid pair preparation date");
  // Dynamic import happens after CLI env selection; database.ts otherwise loads .env.
  const { nativeWordPair } = await import("../src/features/progress/nativeWordPairs.js");
  const [recognition, production] = nativeWordPair(parent as UserProgress, spanish as Word, german as Word, relation.study);
  recognition.createdAt = preparedAt;
  const pair: ReviewedLegacyPair = { parentBefore: parent, parentCard: production.card, recognition, sourceRelation: { _id: relation._id, main: relation.main, translated: relation.translated, study: relation.study }, parentRestSHA256: digestRest(parent) };
  validateWordCardManifest(contentManifest(pair));
  if (recognition.card?.direction !== "DE_ES" || recognition.card?.source !== "APP" || !recognition.userId.equals(parent.userId) || !recognition.relationId.equals(relationId) || !recognition.itemId.equals(recognition._id) || recognition.scheduler.phase !== "NEW") error("Native pair builder returned an incompatible recognition card");
  if (!sameWordCardBson(recognition.scheduler.options, parent.scheduler.options) || recognition.scheduler.timeZone !== parent.scheduler.timeZone || !sameWordCardBson(recognition.scheduler.rollover, parent.scheduler.rollover) || !sameWordCardBson(recognition.nextDueDate, parent.nextDueDate)) error("Native recognition schedule differs from the stored profile");
  verifyPairIdentity(pair, preparedAt);
  return pair;
}

export function validateReviewedLegacyBackup(value: unknown): asserts value is ReviewedLegacyBackup {
  const backup = value as ReviewedLegacyBackup;
  if (!backup || number(backup.version) !== 1 || !(backup.preparedAt instanceof Date) || !Number.isFinite(backup.preparedAt.getTime()) || !/^[a-f\d]{64}$/i.test(backup.targetSHA256) || !Array.isArray(backup.pairs) || !backup.pairs.length || Object.keys(backup).some(key => !["version", "preparedAt", "targetSHA256", "pairs"].includes(key))) error("Invalid private native-pair backup");
  const parents = new Set<string>(), recognition = new Set<string>();
  for (const pair of backup.pairs) {
    if (!pair || Object.keys(pair).some(key => !["parentBefore", "parentCard", "recognition", "sourceRelation", "parentRestSHA256"].includes(key)) || !(pair.parentBefore?._id instanceof ObjectId) || !(pair.recognition?._id instanceof ObjectId) || !(pair.sourceRelation?._id instanceof ObjectId) || own(pair.parentBefore, "card") || pair.parentBefore.itemType !== "WORD" || pair.parentRestSHA256 !== digestRest(pair.parentBefore)) error("Invalid backed-up parent or recognition identity");
    completeNewScheduler(pair.parentBefore);
    validateWordCardManifest(contentManifest(pair));
    verifyPairIdentity(pair, backup.preparedAt);
    const parentId = pair.parentBefore._id.toHexString(), readingId = pair.recognition._id.toHexString();
    if (parents.has(parentId) || recognition.has(readingId) || parentId === readingId) error("Duplicate native-pair backup identities");
    parents.add(parentId); recognition.add(readingId);
  }
}

export async function prepareReviewedLegacyPairs(db: Db, ids: ObjectId[], targetSHA256: string): Promise<ReviewedLegacyBackup> {
  if (!ids.length || new Set(ids.map(id => id.toHexString())).size !== ids.length || !/^[a-f\d]{64}$/i.test(targetSHA256)) error("Explicit unique parent IDs and target checksum are required");
  const preparedAt = new Date(), pairs: ReviewedLegacyPair[] = [];
  for (const id of ids) {
    const parent = await db.collection("userprogresses").findOne({ _id: id });
    if (!parent) error("A selected legacy parent is missing");
    const relation = await db.collection("WORDS_ES_DE").findOne({ _id: parent.relationId ?? parent.itemId });
    if (!relation) error("A selected parent has no vocabulary relation");
    const spanish = await db.collection("WORDS_ES").findOne({ _id: relation.main }), german = await db.collection("WORDS_DE").findOne({ _id: relation.translated });
    if (!spanish || !german) error("A selected parent has a missing vocabulary endpoint");
    const pair = await planReviewedLegacyPair(parent, relation, spanish, german, preparedAt);
    if (await db.collection("userprogresses").findOne({ _id: pair.recognition._id }, { projection: { _id: 1 } })) error("Deterministic recognition ID already exists; refusing a collision");
    if (await db.collection("reviewevents").findOne({ userId: parent.userId, itemId: pair.recognition.itemId }, { projection: { _id: 1 } })) error("Recognition ID already has review history");
    pairs.push(pair);
  }
  const backup: ReviewedLegacyBackup = { version: 1, preparedAt, targetSHA256, pairs };
  validateReviewedLegacyBackup(backup);
  return backup;
}

export async function writeReviewedLegacyBackup(path: string, backup: ReviewedLegacyBackup) {
  validateReviewedLegacyBackup(backup);
  let handle;
  try { handle = await open(path, "wx", 0o600); await handle.writeFile(serializeWordCardEjson(backup)); await handle.sync(); }
  catch { error("Could not create the private pair backup; never overwrite an existing backup"); }
  finally { await handle?.close(); }
}
export async function readReviewedLegacyBackup(path: string): Promise<ReviewedLegacyBackup> {
  let backup: unknown;
  try { backup = BSON.EJSON.parse(await readFile(path, "utf8"), { relaxed: false }); }
  catch { error("Private pair backup could not be read as BSON EJSON"); }
  validateReviewedLegacyBackup(backup);
  return backup;
}
export function reviewedLegacyJournalManifest(backup: ReviewedLegacyBackup, backupSHA256: string): WordCardManifest {
  return { version: 1, auditedAt: backup.preparedAt, snapshotSHA256: backupSHA256, patches: backup.pairs.map(pair => contentManifest(pair).patches[0]), inserts: [] };
}
function exactDocument(document: Document) { return { _id: document._id, $expr: { $eq: ["$$ROOT", { $literal: document }] } }; }
function sourceFilter(source: ReviewedLegacyPair["sourceRelation"]) {
  return { _id: source._id, $and: ["main", "translated", "study"].map(key => ({ $expr: { $eq: [`$${key}`, { $literal: source[key] }] } })) };
}
async function pairState(db: Db, pair: ReviewedLegacyPair, rollback: boolean, session?: ClientSession): Promise<"change" | "already" | "conflict"> {
  const parent = await db.collection("userprogresses").findOne({ _id: pair.parentBefore._id }, { session });
  const reading = await db.collection("userprogresses").findOne({ _id: pair.recognition._id }, { session });
  const before = sameWordCardBson(parent, pair.parentBefore), after = sameWordCardBson(parent, afterParent(pair));
  if (rollback && before && !reading) return "already";
  if (!rollback && after && sameWordCardBson(reading, pair.recognition)) return "already";
  if (rollback ? !after || !sameWordCardBson(reading, pair.recognition) : !before || !!reading) return "conflict";
  if (await db.collection("reviewevents").findOne({ userId: pair.parentBefore.userId, itemId: pair.recognition.itemId }, { session, projection: { _id: 1 } })) return "conflict";
  if (!rollback) {
    if (!await db.collection("WORDS_ES_DE").findOne(sourceFilter(pair.sourceRelation), { session, projection: { _id: 1 } })) return "conflict";
    if (!await db.collection("WORDS_ES").findOne({ _id: pair.sourceRelation.main }, { session, projection: { _id: 1 } }) || !await db.collection("WORDS_DE").findOne({ _id: pair.sourceRelation.translated }, { session, projection: { _id: 1 } })) return "conflict";
  }
  return "change";
}

/** Each parent/card + sibling change commits atomically; parent schedule stays byte-equal. */
export async function runReviewedLegacyPairs(client: MongoClient, db: Db, backup: ReviewedLegacyBackup, options: { mode?: MigrationMode; journal?: MigrationJournal } = {}): Promise<PairResult> {
  validateReviewedLegacyBackup(backup);
  const mode = options.mode ?? "dry-run", rollback = mode === "rollback";
  if (!["dry-run", "apply", "rollback"].includes(mode) || (mode !== "dry-run" && !options.journal)) error("Pair writes require a valid mode and durable private journal");
  const result: PairResult = { mode, selected: backup.pairs.length, changed: 0, already: 0, conflicts: 0, complete: true };
  for (const [index, pair] of backup.pairs.entries()) {
    const state = await pairState(db, pair, rollback);
    if (state === "conflict") {
      result.conflicts++; result.complete = false;
      await options.journal?.record({ mode, kind: "patch", collection: "userprogresses", index, status: "conflict" });
    }
    else if (state === "already") result.already++;
  }
  if (mode === "dry-run" || !result.complete) return result;
  result.already = 0;
  const order = backup.pairs.map((pair, index) => ({ pair, index }));
  if (rollback) order.reverse();
  for (const { pair, index } of order) {
    const event = { mode, kind: "patch" as const, collection: "userprogresses" as const, index };
    await options.journal!.record({ ...event, status: "started" });
    const session = client.startSession();
    let state: "change" | "already";
    try {
      state = await session.withTransaction(async () => {
        const current = await pairState(db, pair, rollback, session);
        if (current === "conflict") throw new PairConflict();
        if (current === "already") return "already" as const;
        if (rollback) {
          if (!(await db.collection("userprogresses").updateOne(exactDocument(afterParent(pair)), { $unset: { card: "" } }, { session })).matchedCount) throw new PairConflict();
          if (!(await db.collection("userprogresses").deleteOne(exactDocument(pair.recognition), { session })).deletedCount) throw new PairConflict();
        } else {
          // A same-value write locks the reviewed source against concurrent revisions.
          if (!(await db.collection("WORDS_ES_DE").updateOne(sourceFilter(pair.sourceRelation), { $set: { study: pair.sourceRelation.study } }, { session })).matchedCount) throw new PairConflict();
          if (!(await db.collection("userprogresses").updateOne(exactDocument(pair.parentBefore), { $set: { card: pair.parentCard } }, { session })).matchedCount) throw new PairConflict();
          await db.collection("userprogresses").insertOne(pair.recognition, { session });
        }
        const parent = await db.collection("userprogresses").findOne({ _id: pair.parentBefore._id }, { session });
        if (!parent || digestRest(parent) !== pair.parentRestSHA256 || !sameWordCardBson(parent, rollback ? pair.parentBefore : afterParent(pair))) throw new PairConflict();
        return "change" as const;
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } catch (failure) {
      if (failure instanceof PairConflict || (failure as { code?: number }).code === 11000) {
        result.conflicts++; result.complete = false;
        await options.journal!.record({ ...event, status: "conflict" });
        break;
      }
      await options.journal!.record({ ...event, status: "failed" });
      error(`Native pair transaction failed at index ${index}; preserve its private backup and journal`);
    } finally { await session.endSession(); }
    if (state === "already") result.already++;
    else result.changed++;
    await options.journal!.record({ ...event, status: state === "already" ? "already" : rollback ? "rolledBack" : "applied" });
  }
  return result;
}

async function main() {
  const usage = "Usage: npx tsx scripts/pairReviewedLegacyWords.ts --ids id1,id2 [--backup private.ejson] [--apply|--rollback] [--journal private.ejsonl] [--database name] [--env-file path]";
  let client: MongoClient | undefined, journal: FileWordCardJournal | undefined;
  try {
    const values: Record<string, string> = {};
    let mode: MigrationMode = "dry-run";
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (["--apply", "--rollback"].includes(key)) { if (mode !== "dry-run") error(usage); mode = key === "--apply" ? "apply" : "rollback"; }
      else if (["--ids", "--backup", "--journal", "--database", "--env-file"].includes(key) && !values[key] && args[i + 1] && !args[i + 1].startsWith("--")) values[key] = args[++i];
      else error(usage);
    }
    const textIds = values["--ids"]?.split(",") || [];
    if (!textIds.length || textIds.some(id => !/^[a-f\d]{24}$/i.test(id)) || new Set(textIds.map(id => id.toLowerCase())).size !== textIds.length || (mode !== "dry-run" && !values["--backup"])) error(usage);
    dotenv.config({ path: values["--env-file"] ? resolve(values["--env-file"]) : ".env", override: false });
    let uri = process.env.MONGODB_URI;
    if (!uri) {
      const { DB_USER, DB_USER_PASSWORD, DB_CLUSTER } = process.env;
      if (!DB_USER || !DB_USER_PASSWORD || !DB_CLUSTER || !/^[a-z\d.-]+$/i.test(DB_CLUSTER)) error("Configure explicit MongoDB connection values");
      uri = `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_USER_PASSWORD)}@${DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
    }
    const databaseName = values["--database"] || process.env.DB_NAME || "gramatikapp";
    if (!/^mongodb(?:\+srv)?:\/\//.test(uri) || !/^[A-Za-z\d_-]+$/.test(databaseName)) error("Invalid MongoDB connection configuration");
    const server = uri.replace(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+).*$/, "$1").toLowerCase();
    const targetSHA256 = wordCardSHA256(`${server}/${databaseName}`);
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 }); await client.connect();
    const db = client.db(databaseName), ids = textIds.map(id => new ObjectId(id));
    const backupPath = values["--backup"] ? resolve(values["--backup"]) : undefined;
    let backup: ReviewedLegacyBackup;
    if (backupPath) {
      let saved: Buffer | undefined;
      try { saved = await readFile(backupPath); } catch (failure) { if ((failure as { code?: string }).code !== "ENOENT") error("Private backup could not be read"); }
      if (saved) backup = await readReviewedLegacyBackup(backupPath);
      else {
        if (mode === "rollback") error("Rollback requires the original private backup");
        backup = await prepareReviewedLegacyPairs(db, ids, targetSHA256);
        await writeReviewedLegacyBackup(backupPath, backup);
      }
    } else backup = await prepareReviewedLegacyPairs(db, ids, targetSHA256);
    if (backup.targetSHA256 !== targetSHA256 || !sameWordCardBson(backup.pairs.map(pair => pair.parentBefore._id.toHexString()).sort(), ids.map(id => id.toHexString()).sort())) error("Private backup belongs to a different target or selected IDs");
    if (mode !== "dry-run") {
      const backupHash = wordCardSHA256(await readFile(backupPath!));
      journal = await FileWordCardJournal.open(resolve(values["--journal"] || `${backupPath}.journal.ejsonl`), reviewedLegacyJournalManifest(backup, backupHash), targetSHA256);
    }
    const result = await runReviewedLegacyPairs(client, db, backup, { mode, journal });
    console.log(JSON.stringify(result)); if (!result.complete) process.exitCode = 2;
  } catch (failure) {
    console.error(failure instanceof WordCardMigrationError ? failure.message : "Reviewed native-pair preparation failed; preserve private recovery files and check transaction-capable MongoDB configuration");
    process.exitCode = 1;
  } finally {
    await client?.close().catch(() => undefined);
    await journal?.close().catch(() => { console.error("Could not close the private pair journal; inspect its lock before retrying"); process.exitCode = 1; });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
