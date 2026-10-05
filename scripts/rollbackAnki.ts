import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { BSON, MongoClient, ObjectId } from "mongodb";
const [resultPath, flag] = process.argv.slice(2);
if (!resultPath) throw new Error("Usage: rollbackAnki.ts result.json [--apply]");
const result = JSON.parse(await readFile(resultPath, "utf8"));
const before = BSON.EJSON.parse(await readFile(result.backupPath, "utf8"), { relaxed: false });
const after = BSON.EJSON.parse(await readFile(resolve(dirname(resultPath), `after-${result.importId}.ejson`), "utf8"), { relaxed: false });
const uri = process.env.MONGODB_URI || `mongodb+srv://${process.env.DB_USER}:${process.env.DB_USER_PASSWORD}@${process.env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
const client = await new MongoClient(uri).connect();
const serialize = (doc: any) => BSON.EJSON.stringify(doc, { relaxed: false });
try {
  const db = client.db("gramatikapp");
  const changes: { name: string; expected: any; original?: any }[] = [];
  for (const name of [...Object.keys(after.content), "userprogresses"]) {
    const originals = new Map((name === "userprogresses" ? before.progress : before.content[name]).map((doc: any) => [doc._id.toString(), doc]));
    for (const expected of name === "userprogresses" ? after.progress : after.content[name]) {
      const original = originals.get(expected._id.toString());
      if (!original || serialize(expected) !== serialize(original)) changes.push({ name, expected, original });
    }
  }
  // Preflight the entire rollback before changing anything. A new review or
  // failure must never be erased by restoring an older import snapshot.
  const snapshots = new Map<string, Map<string, any>>();
  for (const name of new Set(changes.map(change => change.name))) {
    snapshots.set(name, new Map((await db.collection(name).find({}).toArray()).map(doc => [doc._id.toString(), doc])));
  }
  for (const change of changes) {
    const actual = snapshots.get(change.name)!.get(change.expected._id.toString());
    if (serialize(actual) !== serialize(change.expected)) throw new Error(`Rollback refused: ${change.name}/${change.expected._id} changed after import. No data was restored.`);
  }
  if (flag !== "--apply") console.log(JSON.stringify({ status: "dry run", changes: changes.length }));
  else {
    for (const change of [...changes].reverse()) {
      const filter = { _id: change.expected._id, $expr: { $eq: ["$$ROOT", { $literal: change.expected }] } };
      if (change.original) {
        const restored = await db.collection(change.name).replaceOne(filter, change.original);
        if (!restored.matchedCount) throw new Error("Concurrent change detected; rollback stopped");
      } else {
        const removed = await db.collection(change.name).deleteOne(filter);
        if (!removed.deletedCount) throw new Error("Concurrent change detected; rollback stopped");
      }
    }
    const importId = new ObjectId(result.importId);
    for (const name of ["ANKI_NOTES", "ANKI_CARDS", "ANKI_REVIEWS"]) await db.collection(name).deleteMany({ importId });
    await db.collection("ANKI_IMPORTS").deleteOne({ _id: importId });
    console.log(JSON.stringify({ status: "rolled back", changes: changes.length }));
  }
} finally { await client.close(); }
