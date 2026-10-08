import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BSON, type Document } from "mongodb";
import { WORD_CARD_COLLECTIONS, sameWordCardBson, validateWordCardManifest, wordCardSHA256, type WordCardCollection, type WordCardManifest, type WordCardPatch } from "./lib/wordCardMigration.js";
import { validateReviewedLegacyBackup, type ReviewedLegacyBackup } from "./pairReviewedLegacyWords.js";
import type { WordCardSnapshot } from "./snapshotWordCardAudit.js";
import { CEFR_LEVELS } from "../src/features/levels/levels.js";

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const id = (value: unknown): string => value instanceof BSON.ObjectId ? value.toHexString() : "";
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const lexicalWordFields = new Set(["word", "notes", "examples", "forms", "gramaticalCategories", "relatedWords"]);
const cardFields = ["prompt", "answer", "acceptedAnswers", "notes", "examples"];
const plainCanonicalAnswer = (value: string) => value.replace(/\s*\((?:formal|rflxv\.?)\)/giu, "").normalize("NFC").trim().replace(/\s+/gu, " ");
type Severity = "error" | "unverified";
export interface WordCardVerificationAnomaly { severity: Severity; code: string; collection?: WordCardCollection; id?: string; paths?: string[] }
export interface WordCardVerificationOptions { beforeSHA256: string; afterSHA256?: string; manifestSHA256?: string; pairingBackups?: ReviewedLegacyBackup[]; verifiedAt?: string }

function at(document: unknown, path: string): { present: boolean; value?: unknown } {
  let current: any = document;
  for (const key of path.split(".")) { if (!current || typeof current !== "object" || !own(current, key)) return { present: false }; current = current[key]; }
  return { present: true, value: current };
}
function omitPaths(document: Document, paths: string[]): Document {
  const result = { ...document };
  for (const path of paths) {
    const parts = path.split("."); let current: any = result;
    for (const part of parts.slice(0, -1)) {
      if (!plain(current[part])) { current = undefined; break; }
      current[part] = { ...current[part] }; current = current[part];
    }
    if (current) delete current[parts.at(-1)!];
  }
  return result;
}
function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (sameWordCardBson(before, after)) return [];
  if (!plain(before) || !plain(after)) return [prefix || "document"];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => !own(before, key) || !own(after, key) ? [prefix ? `${prefix}.${key}` : key] : changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
}
function snapshotMaps(snapshot: WordCardSnapshot) {
  const maps = {} as Record<WordCardCollection, Map<string, Document>>;
  for (const collection of WORD_CARD_COLLECTIONS) {
    if (!Array.isArray(snapshot?.collections?.[collection])) throw new Error("verification_snapshot_shape_invalid");
    maps[collection] = new Map();
    for (const document of snapshot.collections[collection]) {
      const documentId = id(document?._id);
      if (!documentId || maps[collection].has(documentId) || (collection === "userprogresses" && document.itemType !== "WORD")) throw new Error("verification_snapshot_identity_invalid");
      maps[collection].set(documentId, document);
    }
  }
  return maps;
}
function lexicalFields(collection: WordCardCollection, document: Document): { path: string; value: unknown; example: boolean; multiline: boolean }[] {
  const fields: ReturnType<typeof lexicalFields> = [];
  const add = (path: string, example = false, multiline = false) => { const value = at(document, path); if (value.present) fields.push({ path, value: value.value, example, multiline }); };
  if (collection === "WORDS_DE" || collection === "WORDS_ES") {
    add("word"); add("notes", false, true); add("examples", true);
    for (const key of Object.keys(plain(document.forms) ? document.forms : {})) add(`forms.${key}`);
    for (const key of Object.keys(plain(document.relatedWords) ? document.relatedWords : {})) add(`relatedWords.${key}`);
  } else if (collection === "WORDS_ES_DE" && document.study) {
    add("study.german"); add("study.spanish"); add("study.notes", false, true); add("study.examples", true);
    if (own(document.study, "germanExamples")) add("study.germanExamples", true);
    if (own(document.study, "spanishExamples")) add("study.spanishExamples", true);
    for (const key of Object.keys(plain(document.study.forms) ? document.study.forms : {})) add(`study.forms.${key}`);
  }
  else if (collection === "userprogresses" && document.card) for (const key of cardFields) add(`card.${key}`, key === "examples", key === "notes");
  return fields;
}

/** Build once: inherited Spanish estimates require the original paired German evidence. */
export function wordCardInsertionClassificationCheck(before: WordCardSnapshot, manifest: WordCardManifest) {
  const originalGerman = new Map(before.collections.WORDS_DE.map(document => [id(document._id), document]));
  const originalRelations = new Map(before.collections.WORDS_ES_DE.map(document => [id(document._id), document]));
  const newGerman = new Set(manifest.inserts.filter(insert => insert.collection === "WORDS_DE").map(insert => id(insert.document._id)));
  const relations = manifest.inserts.filter(insert => insert.collection === "WORDS_ES_DE").map(insert => insert.document);
  for (const patch of manifest.patches.filter(patch => patch.collection === "WORDS_ES_DE")) {
    const prior = originalRelations.get(patch.id.toLowerCase());
    relations.push({ main: own(patch.set, "main") ? patch.set.main : prior?.main, translated: own(patch.set, "translated") ? patch.set.translated : prior?.translated });
  }
  const parents = new Map<string, Document[]>();
  for (const relation of relations) {
    const germanId = id(relation.translated), spanishId = id(relation.main), parent = originalGerman.get(germanId);
    if (parent && !newGerman.has(germanId)) parents.set(spanishId, [...(parents.get(spanishId) || []), parent]);
  }
  return (collection: WordCardCollection, document: Document): boolean => {
    const classification = document.cefrClassification, version = Number(classification?.version);
    if (!classification || !CEFR_LEVELS.includes(document.cefrLevel) || document.cefrLevel !== classification.level ||
      typeof classification.model !== "string" || !classification.model.trim() || !Number.isSafeInteger(version) || version < 1 ||
      !(classification.classifiedAt instanceof Date) || !Number.isFinite(classification.classifiedAt.getTime())) return false;
    if (classification.model !== "parent-estimate") return !/parent[-_ ]?estimate|inherited|placeholder|unknown/iu.test(classification.model);
    if (collection !== "WORDS_ES") return false;
    return (parents.get(id(document._id)) || []).some(parent => {
      const prior = parent.cefrClassification;
      const priorTime = prior?.classifiedAt instanceof Date ? prior.classifiedAt.getTime() : typeof prior?.classifiedAt === "string" ? Date.parse(prior.classifiedAt) : NaN;
      return parent.cefrLevel === document.cefrLevel && prior?.level === parent.cefrLevel &&
        typeof prior.model === "string" && !!prior.model.trim() && Number.isFinite(priorTime) && priorTime === classification.classifiedAt.getTime();
    });
  };
}

/** Offline evidence only. Concurrent protected changes are reported, never repaired. */
export function verifyWordCardAudit(before: WordCardSnapshot, after: WordCardSnapshot, manifest: WordCardManifest, options: WordCardVerificationOptions) {
  validateWordCardManifest(manifest);
  if (!/^[\da-f]{64}$/iu.test(options.beforeSHA256) || options.beforeSHA256.toLowerCase() !== manifest.snapshotSHA256.toLowerCase()) throw new Error("verification_before_checksum_mismatch");
  const original = snapshotMaps(before), current = snapshotMaps(after), anomalies: WordCardVerificationAnomaly[] = [];
  const classificationValid = wordCardInsertionClassificationCheck(before, manifest);
  const add = (severity: Severity, code: string, collection?: WordCardCollection, documentId?: string, paths?: string[]) => anomalies.push({ severity, code, ...(collection ? { collection } : {}), ...(documentId ? { id: documentId } : {}), ...(paths?.length ? { paths } : {}) });
  if (before.database !== after.database || (before.targetSHA256 && after.targetSHA256 && before.targetSHA256 !== after.targetSHA256)) add("error", "snapshot_target_mismatch");
  const patches = new Map(manifest.patches.map(patch => [`${patch.collection}:${patch.id.toLowerCase()}`, patch]));
  const inserts = new Map(manifest.inserts.map(insert => [`${insert.collection}:${id(insert.document._id)}`, insert.document]));
  const pairingParents = new Map<string, ReviewedLegacyBackup["pairs"][number]>(), recognition = new Map<string, Document>();
  for (const backup of options.pairingBackups || []) {
    validateReviewedLegacyBackup(backup);
    const target = after.targetSHA256 || before.targetSHA256;
    if (target && target !== backup.targetSHA256) add("error", "pairing_backup_target_mismatch");
    else if (!target) add("unverified", "pairing_target_not_bound_in_snapshot");
    for (const pair of backup.pairs) {
      const parentId = id(pair.parentBefore._id), readingId = id(pair.recognition._id);
      if (pairingParents.has(parentId) || recognition.has(readingId) || original.userprogresses.has(readingId)) add("error", "pairing_backup_identity_collision", "userprogresses", parentId);
      pairingParents.set(parentId, pair); recognition.set(readingId, pair.recognition);
      if (!original.userprogresses.has(parentId)) add("error", "pairing_parent_missing_before", "userprogresses", parentId);
      const source = current.WORDS_ES_DE.get(id(pair.sourceRelation._id));
      if (!source || ["main", "translated", "study"].some(key => !sameWordCardBson(source[key], pair.sourceRelation[key as keyof typeof pair.sourceRelation]))) add("error", "pairing_source_content_mismatch", "WORDS_ES_DE", id(pair.sourceRelation._id));
    }
  }
  let verifiedPatches = 0, verifiedInserts = 0, verifiedPairParents = 0, verifiedRecognition = 0;
  for (const patch of manifest.patches) {
    const old = original[patch.collection].get(patch.id.toLowerCase()), next = current[patch.collection].get(patch.id.toLowerCase());
    if (!old || !next) { add("error", "patch_document_missing", patch.collection, patch.id); continue; }
    const beforeMismatch = Object.entries(patch.before).filter(([path, value]) => !at(old, path).present || !sameWordCardBson(at(old, path).value, value)).map(([path]) => path).concat(patch.missingBefore.filter(path => at(old, path).present));
    if (beforeMismatch.length) add("error", "manifest_before_values_mismatch", patch.collection, patch.id, beforeMismatch);
    const afterMismatch = Object.entries(patch.set).filter(([path, value]) => !at(next, path).present || !sameWordCardBson(at(next, path).value, value)).map(([path]) => path).concat(patch.unset.filter(path => at(next, path).present));
    if (afterMismatch.length) add("error", "applied_fields_mismatch", patch.collection, patch.id, afterMismatch);
    const guards = (patch as WordCardPatch & { guards?: { before: Record<string, unknown>; missingBefore: string[] } }).guards;
    if (guards) {
      const mismatch = (document: Document) => Object.entries(guards.before).filter(([path, value]) => !at(document, path).present || !sameWordCardBson(at(document, path).value, value)).map(([path]) => path).concat(guards.missingBefore.filter(path => at(document, path).present));
      const oldMismatch = mismatch(old), newMismatch = mismatch(next);
      if (oldMismatch.length) add("error", "manifest_before_guards_mismatch", patch.collection, patch.id, oldMismatch);
      if (newMismatch.length) add("unverified", "protected_guards_changed", patch.collection, patch.id, newMismatch);
    }
    if (patch.collection === "userprogresses" && own(patch.set, "card")) {
      const card = patch.set.card as Document;
      const relationId = id(old.relationId ?? old.itemId), userId = id(old.userId), itemId = id(old.itemId);
      if (!userId || !itemId || card.sourceNoteGuid !== `app-word:${userId}:${relationId}` || card.sourceCardId !== BigInt(`0x${wordCardSHA256(itemId).slice(0, 15)}`).toString()) add("error", "native_card_identity_mismatch", patch.collection, patch.id);
      if (old.scheduler ? old.scheduler.phase === "NEW" : old.isNew === true) add("error", "generic_card_creation_for_new_parent", patch.collection, patch.id);
    }
    if (!beforeMismatch.length && !afterMismatch.length) verifiedPatches++;
  }
  for (const collection of WORD_CARD_COLLECTIONS) for (const [documentId, old] of original[collection]) {
    const next = current[collection].get(documentId);
    if (!next) { add("error", "original_id_missing", collection, documentId); continue; }
    const patch = patches.get(`${collection}:${documentId}`), pair = collection === "userprogresses" ? pairingParents.get(documentId) : undefined;
    const allowed = patch ? [...Object.keys(patch.set), ...patch.unset] : [];
    if (pair) {
      if (at(old, "card").present || allowed.includes("card")) add("error", "pairing_parent_creation_conflict", collection, documentId);
      if (!sameWordCardBson(next.card, pair.parentCard)) add("error", "pairing_parent_card_mismatch", collection, documentId);
      else verifiedPairParents++;
      allowed.push("card");
      if (!sameWordCardBson(omitPaths(old, ["card"]), omitPaths(pair.parentBefore, ["card"]))) add("unverified", "pairing_preparation_protected_state_changed", collection, documentId);
    }
    const remainingChanges = changedPaths(omitPaths(old, allowed), omitPaths(next, allowed));
    if (!remainingChanges.length) continue;
    if (collection === "userprogresses") add("unverified", "protected_progress_changed", collection, documentId, remainingChanges);
    else {
      const lexical = remainingChanges.filter(path => collection === "WORDS_ES_DE" ? ["main", "translated", "study"].includes(path.split(".")[0]) : lexicalWordFields.has(path.split(".")[0]));
      if (lexical.length) add("error", "unplanned_lexical_change", collection, documentId, lexical);
      const protectedPaths = remainingChanges.filter(path => !lexical.includes(path));
      if (protectedPaths.length) add("unverified", "protected_catalog_changed", collection, documentId, protectedPaths);
    }
  }
  for (const insert of manifest.inserts) {
    const documentId = id(insert.document._id), actual = current[insert.collection].get(documentId);
    if (original[insert.collection].has(documentId)) add("error", "insert_id_already_existed_before", insert.collection, documentId);
    if (!actual) { add("error", "planned_insert_missing", insert.collection, documentId); continue; }
    const lexicalPaths = insert.collection === "WORDS_ES_DE" ? ["main", "translated", "study"] : [...lexicalWordFields];
    const changes = changedPaths(insert.document, actual), lexical = changes.filter(path => lexicalPaths.includes(path.split(".")[0]));
    if (lexical.length) add("error", "insert_lexical_mismatch", insert.collection, documentId, lexical);
    const protectedPaths = changes.filter(path => !lexical.includes(path));
    if (protectedPaths.length) add("unverified", "insert_metadata_changed", insert.collection, documentId, protectedPaths);
    if (!changes.length) verifiedInserts++;
    if (insert.collection !== "WORDS_ES_DE") {
      if (!classificationValid(insert.collection, actual)) add("error", "insert_classifier_metadata_missing_or_estimated", insert.collection, documentId);
    }
  }
  for (const [documentId, expected] of recognition) {
    const actual = current.userprogresses.get(documentId);
    if (!actual) { add("error", "recognition_insert_missing", "userprogresses", documentId); continue; }
    if (!sameWordCardBson(actual.card, expected.card)) add("error", "recognition_card_mismatch", "userprogresses", documentId);
    const protectedChanges = changedPaths(omitPaths(expected, ["card"]), omitPaths(actual, ["card"]));
    if (protectedChanges.length) add("unverified", "recognition_protected_state_changed", "userprogresses", documentId, protectedChanges);
    if (sameWordCardBson(actual, expected)) verifiedRecognition++;
  }
  let canonicalCardsChecked = 0;
  for (const collection of WORD_CARD_COLLECTIONS) for (const [documentId, document] of current[collection]) {
    const old = original[collection].get(documentId);
    if (!old && !inserts.has(`${collection}:${documentId}`) && !(collection === "userprogresses" && recognition.has(documentId))) add("unverified", "unplanned_new_record", collection, documentId);
    for (const field of lexicalFields(collection, document)) {
      const values = Array.isArray(field.value) ? field.value : [field.value];
      const invalid: string[] = [];
      const expectsArray = field.example || field.path === "card.acceptedAnswers" || field.path.startsWith("relatedWords.");
      if (expectsArray && !Array.isArray(field.value)) invalid.push("lexical_field_not_array");
      if (!expectsArray && typeof field.value !== "string") invalid.push("lexical_field_not_text");
      for (const value of values) {
        if (typeof value !== "string") { invalid.push("lexical_field_not_text"); continue; }
        if (!value.trim() && !field.multiline && !field.path.startsWith("forms.") && !field.path.startsWith("study.forms.")) invalid.push("empty_lexical_text");
        if (/[<>]|&(?:[a-z][a-z\d]+|#\d+|#x[a-f\d]+);/iu.test(value)) invalid.push("html_in_lexical_field");
        if (/\\[nr]|[\u0000-\u0009\u000b-\u001f]/u.test(value) || (!field.multiline && /[\r\n]/u.test(value))) invalid.push("embedded_lexical_separator");
        if (field.example && /^\s*(?:\d+[.)]|[（(]\d+[）)])\s*/u.test(value)) invalid.push("numbered_example");
      }
      for (const code of new Set(invalid)) add(old && sameWordCardBson(at(old, field.path).value, field.value) ? "unverified" : "error", code, collection, documentId, [field.path]);
    }
    if (collection === "WORDS_ES_DE") {
      const dangling = !current.WORDS_ES.has(id(document.main)) || !current.WORDS_DE.has(id(document.translated));
      if (dangling) add(old && sameWordCardBson([old.main, old.translated], [document.main, document.translated]) ? "unverified" : "error", "dangling_relation_endpoint", collection, documentId);
    }
    if (collection !== "userprogresses" || !document.card) continue;
    const relation = current.WORDS_ES_DE.get(id(document.relationId ?? document.itemId));
    if (!relation) { add("unverified", "card_relation_unavailable", collection, documentId); continue; }
    if (!relation.study) continue;
    const direction = document.card.direction;
    if (!["DE_ES", "ES_DE"].includes(direction)) { add("unverified", "unsupported_card_direction", collection, documentId); continue; }
    const answer = direction === "DE_ES" ? relation.study.spanish : relation.study.german, prompt = direction === "DE_ES" ? relation.study.german : relation.study.spanish;
    const expected: Document = { prompt, answer, notes: relation.study.notes, examples: relation.study.examples };
    const mismatch = cardFields.filter(key => key !== "acceptedAnswers" && (!own(document.card, key) || !sameWordCardBson(document.card[key], expected[key])));
    // Exact manifest/backup equality above binds reviewed aliases. Their presence
    // must not invalidate a canonical card or require typing display annotations.
    const accepted = document.card.acceptedAnswers;
    if (!Array.isArray(accepted) || accepted.some(value => typeof value !== "string" || !value.trim()) || new Set(accepted).size !== accepted.length || !accepted.some(value => value === answer || value === plainCanonicalAnswer(answer))) mismatch.push("acceptedAnswers");
    if (mismatch.length) add("error", "directional_card_not_canonical", collection, documentId, mismatch.map(key => `card.${key}`));
    else canonicalCardsChecked++;
  }
  const errors = anomalies.filter(item => item.severity === "error").length, unverified = anomalies.filter(item => item.severity === "unverified").length;
  return { version: 1, verifiedAt: options.verifiedAt || new Date().toISOString(), status: errors ? "failed" : unverified ? "unverified" : "verified", complete: !errors && !unverified,
    beforeSHA256: options.beforeSHA256, afterSHA256: options.afterSHA256, manifestSHA256: options.manifestSHA256, beforeAuditedAt: before.auditedAt, afterAuditedAt: after.auditedAt,
    counts: { before: Object.fromEntries(WORD_CARD_COLLECTIONS.map(name => [name, original[name].size])), after: Object.fromEntries(WORD_CARD_COLLECTIONS.map(name => [name, current[name].size])), expectedPatches: manifest.patches.length, verifiedPatches, expectedInserts: manifest.inserts.length, verifiedInserts, expectedPairParents: pairingParents.size, verifiedPairParents, expectedRecognition: recognition.size, verifiedRecognition, canonicalCardsChecked, errors, unverified }, anomalies,
    scope: "Four catalog/WORD-progress collections only. All original IDs and protected fields are compared; archival/source fields in these records are protected. Separate archived-source and review-event collections are outside snapshot scope. Classifier checks validate stored metadata, not independent linguistic/classifier truth. Concurrent protected differences are unverified and never repaired." };
}

export async function writeWordCardVerificationReport(path: string, report: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700);
  const handle = await open(path, "wx", 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify(report, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
}
async function main() {
  const args = process.argv.slice(2), values = new Map<string, string>(), backups: string[] = [];
  if (args.length === 1 && args[0] === "--help") { console.log("Offline verifier: --before private.ejson --after private.ejson --manifest private.ejson [--pairing-backup private.ejson ...] [--output private-report.json]"); return; }
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--before", "--after", "--manifest", "--pairing-backup", "--output"].includes(key) || (key !== "--pairing-backup" && values.has(key)) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("verification_arguments_invalid");
    if (key === "--pairing-backup") backups.push(resolve(args[++index])); else values.set(key, args[++index]);
  }
  if (!["--before", "--after", "--manifest"].every(key => values.has(key))) throw new Error("verification_inputs_required");
  const beforePath = resolve(values.get("--before")!), afterPath = resolve(values.get("--after")!), manifestPath = resolve(values.get("--manifest")!);
  const output = resolve(values.get("--output") || `${afterPath}.verification.json`);
  if ([beforePath, afterPath, manifestPath, ...backups].includes(output)) throw new Error("verification_output_overlaps_input");
  const [beforeText, afterText, manifestText, backupTexts] = await Promise.all([readFile(beforePath, "utf8"), readFile(afterPath, "utf8"), readFile(manifestPath, "utf8"), Promise.all(backups.map(path => readFile(path, "utf8")))]);
  const report = verifyWordCardAudit(BSON.EJSON.parse(beforeText, { relaxed: false }), BSON.EJSON.parse(afterText, { relaxed: false }), BSON.EJSON.parse(manifestText, { relaxed: false }), { beforeSHA256: wordCardSHA256(beforeText), afterSHA256: wordCardSHA256(afterText), manifestSHA256: wordCardSHA256(manifestText), pairingBackups: backupTexts.map(value => BSON.EJSON.parse(value, { relaxed: false })) });
  await writeWordCardVerificationReport(output, report);
  console.log(JSON.stringify({ status: report.status, complete: report.complete, counts: report.counts }));
  if (!report.complete) process.exitCode = report.status === "failed" ? 2 : 3;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error(JSON.stringify({ status: "verification_failed", reason: "Inputs, checksums, manifest/backup scope or exclusive output are invalid; raw source contents are suppressed" })); process.exitCode = 1; });
