import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MongoClient, ObjectId, BSON } from "mongodb";
import { normalizeWord, noteContent, germanLexemeKey, stableId } from "./lib/anki.js";
const [resultPath, exportPath, flag] = process.argv.slice(2);
if (!resultPath || !exportPath) throw new Error("Usage: repairAnkiIdentities.ts result.json export.json [--apply]");
const result = JSON.parse(await readFile(resultPath, "utf8"));
const source = JSON.parse(await readFile(exportPath, "utf8"));
const original = BSON.EJSON.parse(await readFile(result.backupPath, "utf8"));
const afterPath = resolve(dirname(resultPath), `after-${result.importId}.ejson`);
const snapshot = BSON.EJSON.parse(await readFile(afterPath, "utf8"));
const uri = process.env.MONGODB_URI || `mongodb+srv://${process.env.DB_USER}:${process.env.DB_USER_PASSWORD}@${process.env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
const client = await new MongoClient(uri).connect();
try {
  const db = client.db("gramatikapp"), user = await db.collection("users").findOne({ email: result.account });
  const groups = new Map<string, any[]>();
  for (const note of source.tables.notes) {
    const content = noteContent(note, source.tables);
    if (content.isCloze) continue;
    const key = normalizeWord(content.german, true), list = groups.get(key) || [];
    list.push({ note, content }); groups.set(key, list);
  }
  const progress = await db.collection("userprogresses").find({ userId: user._id, "card.source": "ANKI" }).toArray();
  const wordChanges: any[] = [], relationChanges: any[] = [];
  for (const [core, entries] of groups) {
    if (new Set(entries.map(entry => germanLexemeKey(entry.content.german, entry.content.forms, entry.content.categories))).size < 2) continue;
    const relations = await db.collection("WORDS_ES_DE").find({ _id: { $in: progress.filter(p => entries.some(entry => entry.note.guid === p.card.sourceNoteGuid)).map(p => p.relationId) } }).toArray();
    const currentWords = await db.collection("WORDS_DE").find({ _id: { $in: relations.map(r => r.translated) } }).toArray();
    if (new Set(currentWords.map(w => w._id.toString())).size > 1) continue; // Already repaired.
    const old = currentWords[0];
    const expected = snapshot.content.WORDS_DE.find((w: any) => w._id.equals(old._id));
    if (BSON.EJSON.stringify(expected) !== BSON.EJSON.stringify(old)) throw new Error(`Word ${old.word} changed after import; refusing to overwrite it`);
    const before = original.content.WORDS_DE.find((w: any) => w._id.equals(old._id));
    const keeper = before ? entries.find(entry => entry.content.german.replace(/^(der|die|das)\s+/i, "") === before.word) || entries[0] : entries[0];
    for (const entry of entries) {
      const { content, note } = entry;
      const id = entry === keeper ? old._id : stableId(`word:DE:${germanLexemeKey(content.german, content.forms, content.categories)}`);
      const base = entry === keeper && before ? before : { _id: id, contexts: [], createdAt: old.createdAt, examples: [] };
      const doc = { ...base, _id: id, word: content.german.replace(/^(der|die|das)\s+/i, ""), forms: { ...Object.fromEntries(Object.entries(base.forms || {}).filter(([, value]) => !!value)), ...content.forms },
        gramaticalCategories: content.categories, notes: [...new Set([base.notes, content.notes].filter(Boolean))].join("\n\n"), examples: [...new Set([...(base.examples || []), ...content.deExamples])] };
      wordChanges.push({ before: entry === keeper ? old : null, after: doc });
      const relationId = progress.find(p => p.card.sourceNoteGuid === note.guid).relationId;
      const relation = relations.find(r => r._id.equals(relationId));
      if (!relation.translated.equals(id)) relationChanges.push({ before: relation, after: { ...relation, translated: id } });
    }
  }
  const summary = { wordRecordsCorrected: wordChanges.length, identitiesSeparated: relationChanges.length };
  if (flag !== "--apply") console.log(JSON.stringify({ status: "dry run", ...summary }));
  else if (wordChanges.length) {
    await writeFile(resolve(dirname(resultPath), "identity-repair-before.ejson"), BSON.EJSON.stringify({ wordChanges, relationChanges }, { relaxed: false }), { mode: 0o600 });
    await db.collection("WORDS_DE").bulkWrite(wordChanges.map(change => ({ replaceOne: { filter: { _id: change.after._id }, replacement: change.after, upsert: true } })));
    await db.collection("WORDS_ES_DE").bulkWrite(relationChanges.map(change => ({ updateOne: { filter: { _id: change.before._id, translated: change.before.translated }, update: { $set: { translated: change.after.translated } } } })));
    result.content.WORDS_DE.created += relationChanges.length;
    result.homographsSeparated = relationChanges.length;
    for (const change of wordChanges) {
      const index = snapshot.content.WORDS_DE.findIndex((w: any) => w._id.equals(change.after._id));
      if (index === -1) snapshot.content.WORDS_DE.push(change.after);
      else snapshot.content.WORDS_DE[index] = change.after;
    }
    for (const change of relationChanges) snapshot.content.WORDS_ES_DE[snapshot.content.WORDS_ES_DE.findIndex((r: any) => r._id.equals(change.after._id))] = change.after;
    await writeFile(afterPath, BSON.EJSON.stringify(snapshot, { relaxed: false }), { mode: 0o600 });
    await writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    const { importId, backupPath, ...newSummary } = result;
    await db.collection("ANKI_IMPORTS").updateOne({ _id: new ObjectId(importId) }, { $set: { summary: newSummary } });
    console.log(JSON.stringify({ status: "repaired", ...summary }));
  } else console.log(JSON.stringify({ status: "already repaired" }));
} finally { await client.close(); }
