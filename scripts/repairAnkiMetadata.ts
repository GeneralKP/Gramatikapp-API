import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MongoClient, BSON } from "mongodb";
import { noteContent } from "./lib/anki.js";
const [resultPath, exportPath, flag] = process.argv.slice(2);
if (!resultPath || !exportPath) throw new Error("Usage: repairAnkiMetadata.ts result.json export.json [--apply]");
const result = JSON.parse(await readFile(resultPath, "utf8"));
const source = JSON.parse(await readFile(exportPath, "utf8"));
const afterPath = resolve(dirname(resultPath), `after-${result.importId}.ejson`);
const snapshot = BSON.EJSON.parse(await readFile(afterPath, "utf8"));
const uri = process.env.MONGODB_URI || `mongodb+srv://${process.env.DB_USER}:${process.env.DB_USER_PASSWORD}@${process.env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
const client = await new MongoClient(uri).connect();
try {
  const db = client.db("gramatikapp"), user = await db.collection("users").findOne({ email: result.account });
  const progress = await db.collection("userprogresses").find({ userId: user._id, "card.source": "ANKI", itemType: "WORD" }).toArray();
  const relations = await db.collection("WORDS_ES_DE").find({ _id: { $in: progress.map(p => p.relationId) } }).toArray();
  const words = await db.collection("WORDS_DE").find({ _id: { $in: relations.map(r => r.translated) } }).toArray();
  const changes: any[] = [];
  for (const note of source.tables.notes) {
    const content = noteContent(note, source.tables);
    if (content.isCloze) continue;
    const card = progress.find(p => p.card.sourceNoteGuid === note.guid);
    const relation = relations.find(r => r._id.equals(card.relationId));
    const word = words.find(w => w._id.equals(relation.translated));
    const forms = { ...Object.fromEntries(Object.entries(word.forms || {}).filter(([, value]) => !!value)), ...content.forms };
    const displayWord = content.german.replace(/^(der|die|das)\s+/i, "");
    const categories = content.categories.includes("UNKNOWN") ? word.gramaticalCategories : content.categories;
    if (word.word !== displayWord || JSON.stringify(word.forms || {}) !== JSON.stringify(forms) || JSON.stringify(word.gramaticalCategories) !== JSON.stringify(categories)) {
      const expected = snapshot.content.WORDS_DE.find((w: any) => w._id.equals(word._id));
      if (BSON.EJSON.stringify(expected) !== BSON.EJSON.stringify(word)) throw new Error(`Word ${word.word} changed since import; refusing to overwrite it`);
      changes.push({ before: word, after: { ...word, word: displayWord, forms, gramaticalCategories: categories } });
    }
  }
  if (flag !== "--apply") console.log(JSON.stringify({ status: "dry run", metadataUpdates: changes.length }));
  else if (changes.length) {
    await writeFile(resolve(dirname(resultPath), "metadata-repair-before.ejson"), BSON.EJSON.stringify(changes, { relaxed: false }), { mode: 0o600 });
    await db.collection("WORDS_DE").bulkWrite(changes.map(change => ({ updateOne: { filter: { _id: change.before._id }, update: { $set: { word: change.after.word, forms: change.after.forms, gramaticalCategories: change.after.gramaticalCategories } } } })));
    for (const change of changes) snapshot.content.WORDS_DE[snapshot.content.WORDS_DE.findIndex((w: any) => w._id.equals(change.after._id))] = change.after;
    // Keep the original progress snapshot; later review activity must still block rollback.
    await writeFile(afterPath, BSON.EJSON.stringify(snapshot, { relaxed: false }), { mode: 0o600 });
    console.log(JSON.stringify({ status: "repaired", metadataUpdates: changes.length }));
  } else console.log(JSON.stringify({ status: "already repaired" }));
} finally { await client.close(); }
