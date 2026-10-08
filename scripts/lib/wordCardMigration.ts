import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { BSON, ObjectId, type Db, type Document, type Filter } from "mongodb";
import { CEFR_LEVELS } from "../../src/features/levels/levels.js";
import { GrammaticalCategory, LearningContext, WordLevel } from "../../src/features/words/words.types.js";

export const WORD_CARD_COLLECTIONS = ["WORDS_DE", "WORDS_ES", "WORDS_ES_DE", "userprogresses"] as const;
export type WordCardCollection = typeof WORD_CARD_COLLECTIONS[number];
export type WordCardInsertCollection = Exclude<WordCardCollection, "userprogresses">;
export const WORD_CARD_PROGRESS_IDENTITY_PATHS = ["userId", "itemId", "relationId", "itemType", "card.direction", "card.source", "card.sourceCardId", "card.sourceNoteGuid"] as const;
export interface WordCardGuards { before: Record<string, unknown>; missingBefore: string[] }
export interface WordCardPatch {
  collection: WordCardCollection;
  id: string;
  set: Record<string, unknown>;
  unset: string[];
  before: Record<string, unknown>;
  missingBefore: string[];
  guards?: WordCardGuards;
}
export interface WordCardInsert { collection: WordCardInsertCollection; document: Document }
export interface WordCardManifest {
  version: 1;
  auditedAt: string | Date;
  snapshotSHA256: string;
  patches: WordCardPatch[];
  inserts: WordCardInsert[];
}
export type MigrationMode = "dry-run" | "apply" | "rollback";
export interface MigrationResult {
  mode: MigrationMode;
  patches: number;
  inserts: number;
  changed: number;
  wouldChange: number;
  already: number;
  conflicts: number;
  complete: boolean;
}
export interface JournalEvent {
  mode: MigrationMode;
  kind: "patch" | "insert";
  collection: WordCardCollection;
  index: number;
  status: "started" | "applied" | "rolledBack" | "already" | "conflict" | "failed";
}
export interface MigrationJournal { record(event: JournalEvent): Promise<void> }
export class WordCardMigrationError extends Error {}

const formKeys = ["perfect", "past", "imperativ", "irregularConjugations", "plural", "gender", "gramaticalCase"];
const relatedKeys = ["synonyms", "antonyms", "homophones", "homonymous", "paronyms", "verbFamilies"];
const wordPaths = new Set(["word", "notes", "examples", "gramaticalCategories", "forms", "relatedWords", ...formKeys.map(k => `forms.${k}`), ...relatedKeys.map(k => `relatedWords.${k}`)]);
const progressPaths = new Set(["card", "card.prompt", "card.answer", "card.acceptedAnswers", "card.notes", "card.examples"]);
const optionalWordPaths = new Set(["notes", "forms", "relatedWords", ...formKeys.map(k => `forms.${k}`), ...relatedKeys.map(k => `relatedWords.${k}`)]);
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const hexId = /^[a-f\d]{24}$/i;
const checksum = /^[a-f\d]{64}$/i;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message: string): never => { throw new WordCardMigrationError(message); };
const date = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime());
const integer = (value: unknown) => typeof value === "number" ? value : value instanceof BSON.Int32 ? value.valueOf() : NaN;

function keys(value: unknown, allowed: readonly string[], label: string, required: readonly string[] = []) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !own(value, key))) fail(`Invalid ${label} fields`);
}
function plainText(value: unknown, label: string, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || /[<>]|&(?:[a-z][a-z\d]+|#\d+|#x[a-f\d]+);/i.test(value) || /\\[nr]|[\u0000-\u0009\u000b-\u001f]/.test(value)) fail(`Invalid plain-text ${label}; use Unicode text and real newline characters`);
}
function strings(value: unknown, label: string, examples = false, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) fail(`Invalid ${label} array`);
  for (const item of value as unknown[]) {
    plainText(item, label);
    if (examples && /^\s*(?:\d+[.)]|[（(]\d+[）)])\s*/u.test(item as string)) fail(`Invalid ${label}; examples must not have leading numbering`);
  }
}
function lexicalValue(path: string, value: unknown) {
  if (path === "study") {
    keys(value, ["version", "german", "spanish", "notes", "examples", "germanExamples", "spanishExamples", "forms", "category", "auditedAt"], "relation study", ["version", "german", "spanish", "notes", "examples", "auditedAt"]);
    const study = value as Record<string, any>;
    if (integer(study.version) !== 1 || !date(study.auditedAt)) fail("Invalid relation study version or BSON audit date");
    plainText(study.german, "study.german"); plainText(study.spanish, "study.spanish");
    plainText(study.notes, "study.notes", true); strings(study.examples, "study.examples", true);
    if (own(study, "germanExamples") || own(study, "spanishExamples")) {
      strings(study.germanExamples, "study.germanExamples", true); strings(study.spanishExamples, "study.spanishExamples", true);
      if (study.germanExamples.length !== study.examples.length || study.spanishExamples.length !== study.examples.length ||
          study.examples.some((example: string, index: number) => example !== `${study.germanExamples[index]} (${study.spanishExamples[index]})`)) fail("Language-specific study examples must exactly match their bilingual pairing");
    }
    if (own(study, "forms")) lexicalValue("forms", study.forms);
    if (own(study, "category")) lexicalValue("gramaticalCategories", [study.category]);
  } else if (path === "card") {
    keys(value, ["source", "sourceCardId", "sourceNoteGuid", "direction", "prompt", "answer", "acceptedAnswers", "notes", "examples", "deck", "tags"], "missing native card", ["source", "sourceCardId", "sourceNoteGuid", "direction", "prompt", "answer", "acceptedAnswers", "notes", "examples", "deck", "tags"]);
    const card = value as Record<string, any>;
    if (card.source !== "APP" || card.direction !== "ES_DE" || card.deck !== "App" || !Array.isArray(card.tags) || card.tags.length || typeof card.sourceCardId !== "string" || !/^\d+$/.test(card.sourceCardId) || typeof card.sourceNoteGuid !== "string" || !/^app-word:[a-f\d]{24}:[a-f\d]{24}$/i.test(card.sourceNoteGuid)) fail("Invalid missing native card identity");
    for (const key of ["prompt", "answer", "acceptedAnswers", "notes", "examples"]) lexicalValue(`card.${key}`, card[key]);
  } else if (path === "forms") {
    keys(value, formKeys, "forms");
    for (const [key, text] of Object.entries(value as object)) plainText(text, `forms.${key}`, true);
  } else if (path === "relatedWords") {
    keys(value, relatedKeys, "relatedWords");
    for (const [key, text] of Object.entries(value as object)) strings(text, `relatedWords.${key}`);
  } else if (path === "gramaticalCategories") {
    if (!Array.isArray(value) || !value.length || value.some(v => !Object.values(GrammaticalCategory).includes(v)) || new Set(value).size !== value.length) fail("Invalid grammatical categories");
  } else if (path === "examples" || path === "card.examples") strings(value, path, true);
  else if (path === "card.acceptedAnswers") strings(value, path, false, true);
  else if (path.startsWith("relatedWords.")) strings(value, path);
  else if (path === "main" || path === "translated") {
    if (!(value instanceof ObjectId)) fail(`Invalid ${path} reference; use BSON EJSON ObjectIds`);
  } else plainText(value, path, path === "notes" || path === "card.notes" || path.startsWith("forms."));
}
function validatePath(collection: WordCardCollection, path: string, unset = false) {
  if (typeof path !== "string" || path.split(".").some(k => !/^[A-Za-z][A-Za-z\d]*$/.test(k) || forbiddenKeys.has(k))) fail("Unsafe migration field path");
  const allowed = collection === "userprogresses" ? progressPaths : collection === "WORDS_ES_DE" ? new Set(["main", "translated", "study"]) : wordPaths;
  if (!allowed.has(path)) fail(`Field outside lexical scope in ${collection}`);
  if (unset && !(collection === "WORDS_ES_DE" && path === "study") && ((collection !== "WORDS_DE" && collection !== "WORDS_ES") || !optionalWordPaths.has(path))) fail(`Cannot unset required card or translation fields in ${collection}`);
}
function safeBson(value: unknown) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") fail("Before values must be serializable BSON; use missingBefore for absent fields");
  if (Array.isArray(value)) value.forEach(safeBson);
  else if (record(value)) for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("$") || key.includes(".") || forbiddenKeys.has(key)) fail("Unsafe before-value object key");
    safeBson(child);
  }
}
function validateInsert(insert: WordCardInsert) {
  keys(insert, ["collection", "document"], "insert", ["collection", "document"]);
  if (!["WORDS_DE", "WORDS_ES", "WORDS_ES_DE"].includes(insert.collection)) fail("Invalid insert collection");
  const document = insert.document;
  if (insert.collection === "WORDS_ES_DE") {
    keys(document, ["_id", "main", "translated", "study", "createdAt"], "relation insert", ["_id", "main", "translated", "createdAt"]);
    lexicalValue("main", document.main); lexicalValue("translated", document.translated);
    if (own(document, "study")) lexicalValue("study", document.study);
  } else {
    keys(document, ["_id", "word", "notes", "examples", "gramaticalCategories", "forms", "relatedWords", "contexts", "level", "cefrLevel", "cefrClassification", "createdAt", "updatedAt"], "word insert", ["_id", "word", "examples", "gramaticalCategories", "contexts", "createdAt"]);
    for (const [key, value] of Object.entries(document)) if (wordPaths.has(key)) lexicalValue(key, value);
    if (!Array.isArray(document.contexts) || document.contexts.some(v => !Object.values(LearningContext).includes(v))) fail("Invalid inserted learning contexts");
    if (own(document, "level") && !Object.values(WordLevel).includes(document.level)) fail("Invalid inserted word level");
    if (own(document, "cefrLevel") && !CEFR_LEVELS.includes(document.cefrLevel)) fail("Invalid inserted CEFR level");
    if (own(document, "cefrClassification")) {
      const classification = document.cefrClassification;
      keys(classification, ["level", "model", "version", "classifiedAt"], "CEFR classification", ["level", "model", "version", "classifiedAt"]);
      if (!CEFR_LEVELS.includes(classification.level) || !Number.isSafeInteger(integer(classification.version)) || integer(classification.version) < 1 || !date(classification.classifiedAt)) fail("Invalid inserted CEFR classification");
      plainText(classification.model, "CEFR model");
      if (document.cefrLevel && document.cefrLevel !== classification.level) fail("Inserted CEFR classification disagrees with its level");
    }
    if (own(document, "updatedAt") && !date(document.updatedAt)) fail("Invalid inserted updatedAt date");
  }
  if (!(document._id instanceof ObjectId) || !date(document.createdAt)) fail("Insert requires a supplied deterministic ObjectId and BSON createdAt date");
}

/** Validate the complete manifest before opening a database or changing a field. */
export function validateWordCardManifest(value: unknown): asserts value is WordCardManifest {
  keys(value, ["version", "auditedAt", "snapshotSHA256", "patches", "inserts"], "manifest", ["version", "auditedAt", "snapshotSHA256", "patches", "inserts"]);
  const manifest = value as WordCardManifest;
  const auditedAt = manifest.auditedAt instanceof Date ? manifest.auditedAt : typeof manifest.auditedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(manifest.auditedAt) ? new Date(manifest.auditedAt) : null;
  if (integer(manifest.version) !== 1 || !date(auditedAt) || typeof manifest.snapshotSHA256 !== "string" || !checksum.test(manifest.snapshotSHA256) || !Array.isArray(manifest.patches) || !Array.isArray(manifest.inserts)) fail("Invalid manifest version, audit date, snapshot checksum or operations");
  if (typeof manifest.auditedAt === "string") {
    const normalized = manifest.auditedAt.includes(".") ? manifest.auditedAt.replace(/\.(\d{1,3})Z$/, (_, fraction: string) => `.${fraction.padEnd(3, "0")}Z`) : manifest.auditedAt.replace(/Z$/, ".000Z");
    if (auditedAt!.toISOString() !== normalized) fail("Invalid manifest audit date");
  }
  const identities = new Set<string>(), pairs = new Set<string>();
  for (const patch of manifest.patches) {
    keys(patch, ["collection", "id", "set", "unset", "before", "missingBefore", "guards"], "patch", ["collection", "id", "set", "unset", "before", "missingBefore"]);
    if (!WORD_CARD_COLLECTIONS.includes(patch.collection) || typeof patch.id !== "string" || !hexId.test(patch.id) || !record(patch.set) || !record(patch.before) || !Array.isArray(patch.unset) || !Array.isArray(patch.missingBefore)) fail("Invalid patch shape, collection or ObjectId");
    const identity = `${patch.collection}:${patch.id.toLowerCase()}`;
    if (identities.has(identity)) fail("Duplicate patch/insert identity; consolidate each document into one patch");
    identities.add(identity);
    const paths = [...Object.keys(patch.set), ...patch.unset];
    if (!paths.length || new Set(paths).size !== paths.length) fail("Empty or duplicate touched paths");
    for (const path of paths) validatePath(patch.collection, path, patch.unset.includes(path));
    if (paths.some((path, i) => paths.some((other, j) => i !== j && other.startsWith(`${path}.`)))) fail("Overlapping parent/child migration paths");
    const originalPaths = [...Object.keys(patch.before), ...patch.missingBefore];
    if (new Set(originalPaths).size !== originalPaths.length || originalPaths.length !== paths.length || originalPaths.some(path => !paths.includes(path))) fail("before and missingBefore must cover each touched field exactly once");
    if (own(patch.set, "card") && (paths.length !== 1 || patch.missingBefore.length !== 1 || patch.missingBefore[0] !== "card" || Object.keys(patch.before).length)) fail("Full native cards may only be created when card is absent; existing source metadata is protected");
    for (const [path, next] of Object.entries(patch.set)) lexicalValue(path, next);
    for (const previous of Object.values(patch.before)) safeBson(previous);
    const requiredGuards = patch.collection === "userprogresses" ? own(patch.set, "card") ? WORD_CARD_PROGRESS_IDENTITY_PATHS.slice(0, 4) : WORD_CARD_PROGRESS_IDENTITY_PATHS : [];
    if (patch.collection === "userprogresses" && !own(patch.set, "card") && !patch.guards) fail("Existing card lexical changes require immutable identity guards");
    if (patch.guards) {
      keys(patch.guards, ["before", "missingBefore"], "guards", ["before", "missingBefore"]);
      if (!record(patch.guards.before) || !Array.isArray(patch.guards.missingBefore)) fail("Invalid guard shape");
      const guarded = [...Object.keys(patch.guards.before), ...patch.guards.missingBefore];
      const allowedGuards: readonly string[] = patch.collection === "userprogresses" ? requiredGuards : patch.collection === "WORDS_ES_DE" ? ["main", "translated"] : ["word"];
      if (!guarded.length || new Set(guarded).size !== guarded.length || guarded.some(path => typeof path !== "string" || !allowedGuards.includes(path))) fail("Unsafe or duplicate guard-only paths");
      if (guarded.some(path => paths.some(touched => path === touched || path.startsWith(`${touched}.`) || touched.startsWith(`${path}.`)))) fail("Guard-only paths must not overlap mutation paths");
      if (requiredGuards.some(path => !guarded.includes(path)) || (requiredGuards.length && guarded.length !== requiredGuards.length)) fail("Identity before/missing guards must cover every required field exactly once");
      for (const [path, previous] of Object.entries(patch.guards.before)) {
        safeBson(previous);
        if (["userId", "itemId", "relationId", "main", "translated"].includes(path) && !(previous instanceof ObjectId)) fail("Identity guards require BSON ObjectIds");
        if (path === "itemType" && previous !== "WORD") fail("Identity guard requires a word progress record");
        if (path === "card.direction" && !["ES_DE", "DE_ES"].includes(previous as string)) fail("Identity guard requires a supported word-card direction");
      }
      if (patch.collection === "userprogresses" && ["userId", "itemId", "itemType", ...(!own(patch.set, "card") ? ["card.direction"] : [])].some(path => !own(patch.guards!.before, path))) fail("Required identity guards cannot be missing");
    }
  }
  for (const insert of manifest.inserts) {
    validateInsert(insert);
    const identity = `${insert.collection}:${insert.document._id.toHexString()}`;
    if (identities.has(identity)) fail("Duplicate patch/insert identity");
    identities.add(identity);
    if (insert.collection === "WORDS_ES_DE") {
      const pair = `${insert.document.main.toHexString()}:${insert.document.translated.toHexString()}`;
      if (pairs.has(pair)) fail("Duplicate inserted translation pair");
      pairs.add(pair);
    }
  }
}

export const wordCardSHA256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const deterministicWordCardId = (identity: string) => new ObjectId(wordCardSHA256(`word-card-audit:${identity}`).slice(0, 24));
export const serializeWordCardEjson = (value: unknown) => BSON.EJSON.stringify(value, { relaxed: false });
export async function readWordCardManifest(path: string): Promise<WordCardManifest> {
  let manifest: unknown;
  try { manifest = BSON.EJSON.parse(await readFile(path, "utf8"), { relaxed: false }); }
  catch { fail("Manifest could not be read as BSON EJSON"); }
  validateWordCardManifest(manifest);
  return { ...manifest, version: 1 };
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const sameWordCardBson = (a: unknown, b: unknown) => serializeWordCardEjson(canonical(a)) === serializeWordCardEjson(canonical(b));
export const manifestSHA256 = (manifest: WordCardManifest) => wordCardSHA256(serializeWordCardEjson(canonical(manifest)));

/** Equality is an expression so a scalar cannot accidentally match one element of an array. */
export function patchStateFilter(patch: WordCardPatch, state: "before" | "after"): Filter<Document> {
  const values = { ...(state === "before" ? patch.before : patch.set), ...patch.guards?.before };
  const missing = [...(state === "before" ? patch.missingBefore : patch.unset), ...(patch.guards?.missingBefore ?? [])];
  const clauses: Document[] = [{ _id: new ObjectId(patch.id) }];
  for (const [path, expected] of Object.entries(values)) clauses.push({ [path]: { $exists: true } }, { $expr: { $eq: [`$${path}`, { $literal: expected }] } });
  for (const path of missing) clauses.push({ [path]: { $exists: false } });
  return { $and: clauses };
}
function patchUpdate(patch: WordCardPatch, state: "before" | "after") {
  const values = state === "before" ? patch.before : patch.set, missing = state === "before" ? patch.missingBefore : patch.unset;
  return { ...(Object.keys(values).length ? { $set: values } : {}), ...(missing.length ? { $unset: Object.fromEntries(missing.map(path => [path, ""])) } : {}) };
}
function applyPatchFilter(patch: WordCardPatch, rollback: boolean, identity: Document[] = []) {
  const filter = patchStateFilter(patch, rollback ? "after" : "before");
  if (!rollback && own(patch.set, "card")) {
    // Unseen words need both native directions. Do not bypass that pairing flow.
    filter.$and!.push({ $or: [
      { scheduler: { $type: "object" }, "scheduler.phase": { $ne: "NEW" } },
      { $and: [{ $or: [{ scheduler: { $exists: false } }, { scheduler: { $type: "null" } }] }, { isNew: { $ne: true } }] },
    ] });
    filter.$and!.push(...identity);
  }
  return filter;
}

/** Private, append-only, fsynced journal. A lock prevents two CLI writers sharing a journal. */
export class FileWordCardJournal implements MigrationJournal {
  private sequence = 0;
  private constructor(private handle: FileHandle, private lock: FileHandle, private path: string) {}
  static async open(path: string, manifest: WordCardManifest, targetSHA256: string) {
    if (!checksum.test(targetSHA256)) fail("Invalid journal target checksum");
    let lock: FileHandle;
    try { lock = await open(`${path}.lock`, "wx", 0o600); }
    catch { fail("Journal is locked or unavailable; inspect the prior process before removing its lock file"); }
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const stat = await handle.stat();
      if (!stat.isFile()) fail("Journal must be a regular private file");
      await handle.chmod(0o600);
      const journal = new FileWordCardJournal(handle, lock, path);
      const header = { version: 1, manifestSHA256: manifestSHA256(manifest), snapshotSHA256: manifest.snapshotSHA256.toLowerCase(), targetSHA256 };
      if (stat.size) {
        let entries: any[];
        try {
          const saved = await readFile(path, "utf8");
          if (!saved.endsWith("\n")) fail("Journal is incomplete or invalid; preserve it for recovery");
          entries = saved.trimEnd().split("\n").map(line => BSON.EJSON.parse(line, { relaxed: false }));
        }
        catch { fail("Journal is incomplete or invalid; preserve it for recovery"); }
        if (!sameWordCardBson(entries![0], header)) fail("Journal belongs to a different manifest or database target");
        journal.sequence = entries!.length - 1;
      } else await journal.append(header);
      return journal;
    } catch (error) {
      await handle?.close(); await lock.close(); await unlink(`${path}.lock`);
      if (error instanceof WordCardMigrationError) throw error;
      fail("Could not initialize the private migration journal");
    }
  }
  private async append(value: unknown) { await this.handle.writeFile(`${serializeWordCardEjson(value)}\n`); await this.handle.sync(); }
  async record(event: JournalEvent) { await this.append({ sequence: ++this.sequence, at: new Date(), ...event }); }
  async close() { try { await this.handle.close(); } finally { await this.lock.close(); await unlink(`${this.path}.lock`); } }
}

type Operation = { kind: "patch"; index: number; value: WordCardPatch } | { kind: "insert"; index: number; value: WordCardInsert };
function operations(manifest: WordCardManifest, rollback: boolean): Operation[] {
  const inserts: Operation[] = manifest.inserts.map((value, index) => ({ kind: "insert", index, value }));
  // New relations must follow their new words, regardless of JSON ordering.
  inserts.sort((a, b) => Number(a.value.collection === "WORDS_ES_DE") - Number(b.value.collection === "WORDS_ES_DE"));
  const patches: Operation[] = manifest.patches.map((value, index) => ({ kind: "patch", index, value }));
  return rollback ? [...patches.reverse(), ...inserts.reverse()] : [...inserts, ...patches];
}
async function relationReferencesValid(db: Db, manifest: WordCardManifest, main: ObjectId, translated: ObjectId, preflight = false) {
  for (const [collection, id] of [["WORDS_ES", main], ["WORDS_DE", translated]] as const) {
    // Preflight permits not-yet-created words; a real relation write must observe them in MongoDB.
    const inserted = preflight ? manifest.inserts.find(i => i.collection === collection && i.document._id.equals(id)) : undefined;
    const patched = preflight ? manifest.patches.find(p => p.collection === collection && p.id.toLowerCase() === id.toHexString()) : undefined;
    const stored = inserted?.document || await db.collection(collection).findOne({ _id: id }, { projection: { word: 1 } });
    const word = patched && own(patched.set, "word") ? patched.set.word : stored?.word;
    if (!stored || typeof word !== "string" || !word.trim()) return false;
  }
  return true;
}
async function insertReferenced(db: Db, insert: WordCardInsert, ignoredRelations: ObjectId[] = []) {
  const id = insert.document._id;
  if (insert.collection === "WORDS_ES_DE") return !!await db.collection("userprogresses").findOne({ itemType: "WORD", $or: [{ relationId: id }, { itemId: id }] }, { projection: { _id: 1 } });
  const relationField = insert.collection === "WORDS_ES" ? "main" : "translated";
  if (await db.collection("WORDS_ES_DE").findOne({ [relationField]: id, ...(ignoredRelations.length ? { _id: { $nin: ignoredRelations } } : {}) }, { projection: { _id: 1 } })) return true;
  const phrases = insert.collection === "WORDS_ES" ? "PHRASES_ES" : "PHRASES_DE";
  return !!await db.collection(phrases).findOne({ words: id }, { projection: { _id: 1 } });
}
async function inspect(db: Db, manifest: WordCardManifest, operation: Operation, rollback: boolean, preflight = false): Promise<"change" | "already" | "conflict"> {
  const { value } = operation, collection = db.collection(value.collection);
  if (operation.kind === "patch") {
    const patch = operation.value;
    let newNativeCard = false;
    if (own(patch.set, "card")) {
      const progress = await collection.findOne({ _id: new ObjectId(patch.id) }, { projection: { userId: 1, itemId: 1, relationId: 1, itemType: 1, "scheduler.phase": 1, isNew: 1 } });
      const card = patch.set.card as Document;
      if (!progress || progress.itemType !== "WORD" || !(progress.userId instanceof ObjectId) || !(progress.itemId instanceof ObjectId) || (progress.relationId && !(progress.relationId instanceof ObjectId))) return "conflict";
      const sourceCardId = BigInt(`0x${wordCardSHA256(progress.itemId.toHexString()).slice(0, 15)}`).toString();
      if (card.sourceCardId !== sourceCardId || card.sourceNoteGuid !== `app-word:${progress.userId}:${progress.relationId ?? progress.itemId}`) return "conflict";
      newNativeCard = progress.scheduler ? progress.scheduler.phase === "NEW" : !!progress.isNew;
    }
    if (await collection.findOne(patchStateFilter(patch, rollback ? "before" : "after"), { projection: { _id: 1 } })) return "already";
    if (!await collection.findOne(patchStateFilter(patch, rollback ? "after" : "before"), { projection: { _id: 1 } })) return "conflict";
    if (!rollback && newNativeCard) return "conflict";
    if (patch.collection === "WORDS_ES_DE") {
      const relation = await collection.findOne({ _id: new ObjectId(patch.id) }, { projection: { main: 1, translated: 1 } });
      const desired = rollback ? patch.before : patch.set;
      if (!relation || !((desired.main ?? relation.main) instanceof ObjectId) || !((desired.translated ?? relation.translated) instanceof ObjectId)) return "conflict";
      // References are validated again immediately before each relation write.
      if (!rollback && !await relationReferencesValid(db, manifest, desired.main ?? relation.main, desired.translated ?? relation.translated, preflight)) return "conflict";
    }
    return "change";
  }
  const insert = operation.value, current = await collection.findOne({ _id: insert.document._id });
  if (current && !sameWordCardBson(current, insert.document)) return "conflict";
  if (rollback) {
    const ignored = preflight ? [
      ...manifest.inserts.filter(i => i.collection === "WORDS_ES_DE").map(i => i.document._id),
      ...manifest.patches.filter(p => p.collection === "WORDS_ES_DE" && own(p.before, insert.collection === "WORDS_ES" ? "main" : "translated") && !sameWordCardBson(p.before[insert.collection === "WORDS_ES" ? "main" : "translated"], insert.document._id)).map(p => new ObjectId(p.id)),
    ] : [];
    return current ? await insertReferenced(db, insert, ignored) ? "conflict" : "change" : "already";
  }
  if (current) return "already";
  if (insert.collection === "WORDS_ES_DE") {
    if (!await relationReferencesValid(db, manifest, insert.document.main, insert.document.translated, preflight)) return "conflict";
    if (await collection.findOne({ main: insert.document.main, translated: insert.document.translated }, { projection: { _id: 1 } })) return "conflict";
  }
  return "change";
}

/** No app startup, indexes, upserts, whole-progress replacement, or scheduler writes. */
export async function runWordCardMigration(db: Db, manifest: WordCardManifest, options: { mode?: MigrationMode; journal?: MigrationJournal; writersPausedForRollback?: boolean } = {}): Promise<MigrationResult> {
  validateWordCardManifest(manifest);
  const mode = options.mode ?? "dry-run", rollback = mode === "rollback";
  if (!["dry-run", "apply", "rollback"].includes(mode)) fail("Invalid migration mode");
  // This assertion does not pause writers or make logical references atomic.
  // Reference checks and deletions are safe only while every other writer stays paused.
  if (rollback && manifest.inserts.length && options.writersPausedForRollback !== true) fail("Rollback with inserted records requires writers paused for the entire operation");
  if (mode !== "dry-run" && !options.journal) fail("Writes require a durable migration journal");
  const result: MigrationResult = { mode, patches: manifest.patches.length, inserts: manifest.inserts.length, changed: 0, wouldChange: 0, already: 0, conflicts: 0, complete: true };
  const work = operations(manifest, rollback);
  // Only reads overlap. Settle each bounded batch before processing statuses or rejecting,
  // so the caller can safely close MongoDB. Journal records retain manifest order.
  // Refuse all known stale values before any write; fresh CAS still protects later races.
  for (let offset = 0; offset < work.length; offset += 8) {
    const batch = work.slice(offset, offset + 8);
    const statuses = await Promise.allSettled(batch.map(operation => inspect(db, manifest, operation, rollback, true)));
    const failures = statuses.filter(status => status.status === "rejected");
    if (failures.length) throw failures[0].reason;
    for (let index = 0; index < batch.length; index++) {
      const operation = batch[index], settled = statuses[index];
      if (settled.status !== "fulfilled") continue;
      if (settled.value === "conflict") {
        result.conflicts++; result.complete = false;
        await options.journal?.record({ mode, kind: operation.kind, collection: operation.value.collection, index: operation.index, status: "conflict" });
      } else if (settled.value === "change") result.wouldChange++;
      else result.already++;
    }
  }
  if (mode === "dry-run" || !result.complete) return result;
  result.already = 0;
  for (const operation of work) {
    const event = { mode, kind: operation.kind, collection: operation.value.collection, index: operation.index };
    let status: "change" | "already" | "conflict";
    try {
      status = await inspect(db, manifest, operation, rollback);
      if (status === "change") {
        await options.journal!.record({ ...event, status: "started" });
        const collection = db.collection(operation.value.collection);
        if (operation.kind === "patch") {
          const identity: Document[] = [];
          if (!rollback && own(operation.value.set, "card")) {
            const current = await collection.findOne({ _id: new ObjectId(operation.value.id) }, { projection: { userId: 1, itemId: 1, relationId: 1, itemType: 1 } });
            const card = operation.value.set.card as Document;
            if (!current || current.itemType !== "WORD" || !(current.userId instanceof ObjectId) || !(current.itemId instanceof ObjectId) || card.sourceCardId !== BigInt(`0x${wordCardSHA256(current.itemId.toHexString()).slice(0, 15)}`).toString() || card.sourceNoteGuid !== `app-word:${current.userId}:${current.relationId ?? current.itemId}`) status = "conflict";
            else for (const path of ["userId", "itemId", "relationId", "itemType"]) {
              identity.push({ [path]: { $exists: own(current, path) } });
              if (own(current, path)) identity.push({ $expr: { $eq: [`$${path}`, { $literal: current[path] }] } });
            }
          }
          const updated = status === "conflict" ? { matchedCount: 0 } : await collection.updateOne(applyPatchFilter(operation.value, rollback, identity), patchUpdate(operation.value, rollback ? "before" : "after"));
          if (!updated.matchedCount) status = await inspect(db, manifest, operation, rollback) === "already" ? "already" : "conflict";
        } else if (rollback) {
          const current = await collection.findOne({ _id: operation.value.document._id });
          if (!current) status = "already";
          else if (!sameWordCardBson(current, operation.value.document) || await insertReferenced(db, operation.value)) status = "conflict";
          else if (!(await collection.deleteOne({ _id: current._id, $expr: { $eq: ["$$ROOT", { $literal: current }] } })).deletedCount) status = "conflict";
        } else {
          try { await collection.insertOne(operation.value.document); }
          catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
            status = await inspect(db, manifest, operation, false) === "already" ? "already" : "conflict";
          }
        }
      }
    } catch {
      await options.journal!.record({ ...event, status: "failed" });
      fail(`Database operation failed at ${operation.kind} index ${operation.index}; inspect the private journal for completed steps`);
    }
    if (status === "change") result.changed++;
    else if (status === "already") result.already++;
    else { result.conflicts++; result.complete = false; }
    await options.journal!.record({ ...event, status: status === "change" ? rollback ? "rolledBack" : "applied" : status });
    if (status === "conflict") break;
  }
  return result;
}
