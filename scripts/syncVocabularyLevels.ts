import "dotenv/config";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BSON } from "mongodb";
import { closeDatabase, connectDatabase } from "../src/lib/database.js";
import { CEFR_LEVELS } from "../src/features/levels/levels.js";

const apply = process.argv.includes("--apply"), db = await connectDatabase();
const folder = resolve(process.env.LEVEL_BACKUP_DIR ?? "../.local/level-sync");
const withoutLevel = (row: any) => { const { level: _level, ...rest } = row; return rest; };
try {
  const report = [];
  for (const key of ["wordsDE", "wordsES", "phrasesDE", "phrasesES"] as const) {
    const collection = db[key], original = await collection.find({}).toArray();
    const invalid = original.filter(row => !(CEFR_LEVELS as readonly string[]).includes(row.cefrLevel ?? ""));
    assert.equal(invalid.length, 0, `${key}: classify missing CEFR entries before synchronizing levels`);
    const changed = original.filter(row => row.level !== row.cefrLevel!.split(".")[0]);
    if (apply && changed.length) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(resolve(folder, `${key}-before-${Date.now()}.ejson`), BSON.EJSON.stringify(changed, { relaxed: false }), { mode: 0o600 });
      await collection.bulkWrite(changed.map(row => ({ updateOne: {
        filter: { _id: row._id, cefrLevel: row.cefrLevel }, update: { $set: { level: row.cefrLevel!.split(".")[0] } },
      } })));
      const current = await collection.find({ _id: { $in: changed.map(row => row._id) } }).toArray();
      const originals = new Map(changed.map(row => [row._id.toString(), row]));
      for (const row of current) {
        assert.equal(row.level, row.cefrLevel!.split(".")[0]);
        assert.deepEqual(withoutLevel(row), withoutLevel(originals.get(row._id.toString())), "Only the legacy level field may change");
      }
    }
    report.push({ collection: key, total: original.length, synchronized: apply ? changed.length : 0, pending: apply ? 0 : changed.length });
  }
  console.log(JSON.stringify({ mode: apply ? "applied and verified" : "dry run", report }));
} finally { await closeDatabase(); }
