import "dotenv/config";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { BSON } from "mongodb";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { CLASSIFICATION_INSTRUCTIONS, CLASSIFICATION_SCHEMA, CLASSIFICATION_VERSION, validateClassifications } from "../src/features/levels/levels.js";
import { requestStructured } from "../src/features/reading/openai.js";
import { READING_MODEL } from "../src/features/reading/prompts.js";
const args = process.argv.slice(2), apply = args.includes("--apply");
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const output = resolve(option("--output", "../.local/levels")), batchSize = Math.max(1, Math.min(150, Number(option("--batch-size", "100"))));
const workers = Math.max(1, Math.min(4, Number(option("--workers", "3")))), limit = Number(option("--limit", "0"));
const db = await connectDatabase();
try {
  const configs = [["wordsDE", "word", "German"], ["wordsES", "word", "Spanish"], ["phrasesDE", "phrase", "German"], ["phrasesES", "phrase", "Spanish"]] as const;
  const batches: { collection: any; key: string; field: string; language: string; docs: any[] }[] = [];
  const summary: Record<string, { total: number; pending: number; classified: number; failed: number }> = {};
  let remaining = limit || Infinity;
  await mkdir(output, { recursive: true });
  for (const [key, field, language] of configs) {
    const collection = db[key], all = await collection.find({}).toArray();
    const pending = all.filter(p => p.cefrClassification?.version !== CLASSIFICATION_VERSION || !p.cefrLevel);
    summary[key] = { total: all.length, pending: pending.length, classified: 0, failed: 0 };
    const selected = pending.slice(0, remaining); remaining -= selected.length;
    if (apply && selected.length) await writeFile(resolve(output, `${key}-before-${Date.now()}.ejson`), BSON.EJSON.stringify(selected, { relaxed: false }), { mode: 0o600 });
    for (let i = 0; i < selected.length; i += batchSize) batches.push({ collection, key, field, language, docs: selected.slice(i, i + batchSize) });
  }
  if (!apply) console.log(JSON.stringify({ status: "dry run", summary, batches: batches.length }, null, 2));
  else {
    let cursor = 0, progressWrites = Promise.resolve();
    await Promise.all(Array.from({ length: workers }, async () => {
      while (cursor < batches.length) {
        const index = cursor++, batch = batches[index];
        try {
          let entries: ReturnType<typeof validateClassifications> | undefined;
          for (let attempt = 0; attempt < 3 && !entries; attempt++) {
            try {
              const ids = batch.docs.map((_, i) => String(i + 1));
              const value = await requestStructured(CLASSIFICATION_INSTRUCTIONS, JSON.stringify({ language: batch.language, entries: batch.docs.map((p, i) => ({ id: ids[i], text: p[batch.field], partOfSpeech: p.gramaticalCategories ?? [] })) }), "cefr_classification", CLASSIFICATION_SCHEMA);
              entries = validateClassifications(value, ids).map(entry => ({ ...entry, id: batch.docs[Number(entry.id) - 1]._id.toString() }));
            } catch (error) { if (attempt === 2 || /credits|quota|spending|usage limit|key cannot/i.test((error as Error).message)) throw error; }
          }
          const now = new Date();
          const result = await batch.collection.bulkWrite(entries!.map(entry => {
            const original = batch.docs.find(p => p._id.toString() === entry.id);
            return { updateOne: { filter: { _id: original._id, [batch.field]: original[batch.field] }, update: { $set: { cefrLevel: entry.level, cefrClassification: { level: entry.level, model: READING_MODEL, version: CLASSIFICATION_VERSION, classifiedAt: now } } } } };
          }));
          summary[batch.key].classified += result.matchedCount;
          console.log(JSON.stringify({ batch: index + 1, batches: batches.length, collection: batch.key, classified: result.matchedCount }));
        } catch (error) { summary[batch.key].failed += batch.docs.length; console.error(JSON.stringify({ batch: index + 1, collection: batch.key, error: (error as Error).message })); }
        const snapshot = JSON.stringify({ updatedAt: new Date().toISOString(), summary }, null, 2);
        progressWrites = progressWrites.then(async () => {
          await writeFile(resolve(output, "classification-progress.tmp"), snapshot, { mode: 0o600 });
          await rename(resolve(output, "classification-progress.tmp"), resolve(output, "classification-progress.json"));
        });
        await progressWrites;
      }
    }));
    const verification = [];
    for (const [key] of configs) verification.push({ collection: key, total: await db[key].countDocuments(), classified: await db[key].countDocuments({ "cefrClassification.version": CLASSIFICATION_VERSION, cefrLevel: { $exists: true } }) });
    await writeFile(resolve(output, "classification-result.json"), JSON.stringify({ summary, verification }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: "finished", verification }, null, 2));
    if (Object.values(summary).some(s => s.failed) || !limit && verification.some(v => v.classified !== v.total)) process.exitCode = 1;
  }
} finally { await closeDatabase(); }
