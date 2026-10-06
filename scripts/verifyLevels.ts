import "dotenv/config";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BSON } from "mongodb";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { CEFR_LEVELS, CLASSIFICATION_VERSION } from "../src/features/levels/levels.js";

const directory = resolve(process.argv[2] || "../.local/levels"), db = await connectDatabase();
try {
  const files = (await readdir(directory)).sort(), report: any[] = [];
  const content = (row: any) => { const { level: _band, cefrLevel: _level, cefrClassification: _metadata, ...original } = row; return original; };
  for (const key of ["wordsDE", "wordsES", "phrasesDE", "phrasesES"] as const) {
    const originals = new Map<string, any>();
    for (const file of files.filter(file => file.startsWith(`${key}-before-`) && file.endsWith(".ejson"))) {
      const rows = BSON.EJSON.parse(await readFile(resolve(directory, file), "utf8"));
      for (const row of rows) if (!originals.has(row._id.toString())) originals.set(row._id.toString(), row);
    }
    const current = await db[key].find({}).toArray();
    assert.equal(originals.size, current.length, `${key}: every entry has a before snapshot`);
    for (const row of current) {
      assert.ok(CEFR_LEVELS.includes(row.cefrLevel)); assert.equal(row.cefrClassification?.version, CLASSIFICATION_VERSION);
      assert.equal(row.cefrClassification?.level, row.cefrLevel); assert.ok(row.cefrClassification.classifiedAt instanceof Date);
      assert.equal(row.level, row.cefrLevel.split(".")[0]);
      assert.deepEqual(content(row), content(originals.get(row._id.toString())), `${key}/${row._id}: classification preserved every original field`);
    }
    const distribution = Object.fromEntries(CEFR_LEVELS.map(level => [level, current.filter(row => row.cefrLevel === level).length]));
    const field = key.startsWith("words") ? "word" : "phrase";
    const samples = Object.fromEntries(CEFR_LEVELS.map(level => [level, current.filter(row => row.cefrLevel === level).slice(0, 3).map((row: any) => row[field])]));
    report.push({ collection: key, total: current.length, classified: current.length, originalFieldsPreserved: true, distribution, samples });
    console.log(`PASS ${key}: ${current.length}/${current.length} classified, all original fields unchanged`);
  }
  await writeFile(resolve(directory, "verification.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), total: report.reduce((sum, r) => sum + r.total, 0), model: "gpt-6-luna", effort: "high", report }, null, 2), { mode: 0o600 });
} finally { await closeDatabase(); }
