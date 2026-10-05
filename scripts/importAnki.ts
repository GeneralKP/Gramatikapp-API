import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { MongoClient, ObjectId, BSON } from "mongodb";
import { stableId, normalizeWord, germanLexemeKey, noteContent, studyCard, dueDate, collectionConfig } from "./lib/anki.js";

const args = process.argv.slice(2);
const option = (key: string, fallback?: string) => args[args.indexOf(key) + 1] && args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const exportPath = option("--export"), email = option("--email");
if (!exportPath || !email) throw new Error("Usage: tsx scripts/importAnki.ts --export export.json --email account --timezone Europe/Berlin [--apply] [--output directory]");
const apply = args.includes("--apply"), timeZone = option("--timezone", "Europe/Berlin")!;
const output = resolve(option("--output", "../.local/anki-import")!);
const source = JSON.parse(await readFile(exportPath, "utf8")), tables = source.tables;
const uri = process.env.MONGODB_URI || (process.env.DB_CLUSTER ? `mongodb+srv://${process.env.DB_USER}:${process.env.DB_USER_PASSWORD}@${process.env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority` : "mongodb://localhost:27017");
const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 10000 }).connect();
const db = client.db("gramatikapp");
const contentNames = ["WORDS_DE", "WORDS_ES", "WORDS_ES_DE", "PHRASES_DE", "PHRASES_ES", "PHRASES_ES_DE"];
const now = new Date();
try {
  const user = await db.collection("users").findOne({ email });
  if (!user) throw new Error("Target account does not exist");
  const userId = user._id;
  const importId = stableId(`anki-import:${userId}:${source.sourceHash}`);
  const previousImport = await db.collection("ANKI_IMPORTS").findOne({ _id: importId });
  if (previousImport?.status === "complete") {
    console.log(JSON.stringify({ status: "already imported", ...previousImport.summary }, null, 2));
    process.exitCode = 0;
  } else {
    const current = Object.fromEntries(await Promise.all(contentNames.map(async name => [name, await db.collection(name).find({}).toArray()])));
    const allProgress = await db.collection("userprogresses").find({}).toArray();
    const userProgress = allProgress.filter(p => p.userId.equals(userId));
    const config = collectionConfig(tables.config);
    const existingIds = new Set(Object.values(current).flat().map((doc: any) => doc._id.toString()));
    const changed = new Map<string, Map<string, any>>(contentNames.map(name => [name, new Map()]));
    const wordMaps = Object.fromEntries(["DE", "ES"].map(lang => [lang, new Map(current[`WORDS_${lang}`].map((w: any) => [lang === "DE" ? germanLexemeKey(w.word, w.forms, w.gramaticalCategories) : normalizeWord(w.word), w]))]));
    const phraseMaps = Object.fromEntries(["DE", "ES"].map(lang => [lang, new Map(current[`PHRASES_${lang}`].map((p: any) => [normalizeWord(p.phrase), p]))]));
    const relationMaps = Object.fromEntries(["WORD", "PHRASE"].map(type => [type, new Map(current[`${type}S_ES_DE`].map((r: any) => [`${r.main}:${r.translated}`, r]))]));
    const put = (name: string, doc: any) => changed.get(name)!.set(doc._id.toString(), doc);
    const word = (lang: string, text: string, metadata: any) => {
      const key = lang === "DE" ? germanLexemeKey(text, metadata.forms, metadata.categories) : normalizeWord(text);
      const unspecifiedKey = `${normalizeWord(text, true)}|noun`;
      const existing = (wordMaps[lang].get(key) || (lang === "DE" && metadata.categories.includes("NOUN") ? wordMaps[lang].get(unspecifiedKey) : undefined)) as any;
      const doc = existing || { _id: stableId(`word:${lang}:${key}`), word: lang === "DE" ? text.replace(/^(der|die|das)\s+/i, "") : text, createdAt: now, gramaticalCategories: ["UNKNOWN"], contexts: [], examples: [] };
      const next = { ...doc, word: lang === "DE" ? text.replace(/^(der|die|das)\s+/i, "") : doc.word, forms: { ...Object.fromEntries(Object.entries(doc.forms || {}).filter(([, value]) => !!value)), ...metadata.forms }, notes: [...new Set([doc.notes, metadata.notes].filter(Boolean))].join("\n\n"),
        examples: [...new Set([...(doc.examples || []), ...metadata.examples].filter(Boolean))] };
      if (!metadata.categories.includes("UNKNOWN") || !doc.gramaticalCategories?.length || doc.gramaticalCategories.includes("UNKNOWN")) next.gramaticalCategories = metadata.categories;
      if (JSON.stringify(next) !== JSON.stringify(doc) || !existing) put(`WORDS_${lang}`, next);
      wordMaps[lang].set(key, next);
      if (lang === "DE" && key !== unspecifiedKey && (wordMaps[lang].get(unspecifiedKey) as any)?._id.equals(next._id)) wordMaps[lang].delete(unspecifiedKey);
      return next;
    };
    const phrase = (lang: string, text: string) => {
      const key = normalizeWord(text), existing = phraseMaps[lang].get(key) as any;
      if (existing) return existing;
      const doc = { _id: stableId(`phrase:${lang}:${key}`), phrase: text, synonyms: [], words: [], contexts: [], createdAt: now };
      phraseMaps[lang].set(key, doc); put(`PHRASES_${lang}`, doc); return doc;
    };
    const contents = new Map<number, any>(), relations = new Map<number, any>();
    for (const note of tables.notes) {
      const content = noteContent(note, tables); contents.set(note.id, content);
      const type = content.isCloze ? "PHRASE" : "WORD";
      const de = content.isCloze ? phrase("DE", content.german) : word("DE", content.german, { forms: content.forms, notes: content.notes, examples: content.deExamples, categories: content.categories });
      const es = content.isCloze ? phrase("ES", content.spanish) : word("ES", content.spanish, { forms: {}, notes: "", examples: content.esExamples, categories: content.categories });
      const key = `${es._id}:${de._id}`;
      let relation = relationMaps[type].get(key) as any;
      if (!relation) {
        relation = { _id: stableId(`relation:${type}:${key}`), main: es._id, translated: de._id, createdAt: now };
        relationMaps[type].set(key, relation); put(`${type}S_ES_DE`, relation);
      }
      relations.set(note.id, { relation, type });
    }
    const notes = new Map(tables.notes.map((n: any) => [n.id, n]));
    const reviews = new Map<number, any[]>();
    for (const review of tables.revlog) { const list = reviews.get(review.cid) || []; list.push(review); reviews.set(review.cid, list); }
    const progressDocs = tables.cards.map((card: any) => {
      const note: any = notes.get(card.nid), content = contents.get(card.nid), { relation, type } = relations.get(card.nid);
      if (!note) throw new Error(`Card ${card.id} has no note`);
      const history = (reviews.get(card.id) || []).sort((a, b) => a.id - b.id);
      const failures = history.filter(r => r.ease === 1);
      const lastReview = history.filter(r => r.ease > 0).at(-1);
      // Lifetime reps and lapses remain separate from the SM-2 success streak.
      const lastAgain = history.findLastIndex(r => r.ease === 1);
      const streak = card.type === 2 ? Math.max(2, history.slice(lastAgain + 1).filter(r => r.ease > 1).length) : 0;
      const id = stableId(`anki-card:${userId}:${note.guid}:${card.ord}`);
      const doc = { _id: id, userId, itemId: id, relationId: relation._id, itemType: type, failureIndex: failures.length,
        sourceFailureCount: failures.length, failureAttemptIds: [], lastFailedAt: failures.length ? new Date(failures.at(-1).id) : undefined,
        ease: card.factor ? card.factor / 1000 : 2.5, interval: Math.max(0, card.ivl), repetitions: streak, totalReviews: card.reps, lapses: card.lapses,
        nextDueDate: dueDate(card, tables.col[0], config, timeZone, now), lastReviewed: lastReview ? new Date(lastReview.id) : null,
        isNew: card.queue === 0, suspended: card.queue < 0, card: studyCard(card, note, tables, content), anki: card, createdAt: now };
      return doc;
    });
    const importedRelations = new Set(progressDocs.map((p: any) => p.relationId.toString()));
    const superseded = userProgress.filter(p => !p.card && importedRelations.has(p.itemId.toString()) && !p.supersededByAnki);
    const summary = { account: email, notes: tables.notes.length, cards: progressDocs.length, reviews: tables.revlog.length,
      importedFailures: progressDocs.reduce((sum: number, p: any) => sum + p.failureIndex, 0), lapses: progressDocs.reduce((sum: number, p: any) => sum + p.lapses, 0),
      directions: Object.fromEntries(["ES_DE", "DE_ES", "CLOZE"].map(direction => [direction, progressDocs.filter((p: any) => p.card.direction === direction).length])),
      newCards: progressDocs.filter((p: any) => p.isNew).length,
      dueCards: progressDocs.filter((p: any) => !p.isNew && !p.suspended && p.nextDueDate <= now).length,
      supersededAppCards: superseded.length, progressCountersBackfilled: allProgress.filter(p => p.failureIndex === undefined).length,
      content: Object.fromEntries([...changed].map(([name, docs]) => [name, { created: [...docs.values()].filter(d => !existingIds.has(d._id.toString())).length, enriched: [...docs.values()].filter(d => existingIds.has(d._id.toString())).length }])),
      timezone: timeZone };
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, "dry-run.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
    if (!apply) console.log(JSON.stringify({ status: "dry run; no database writes", ...summary }, null, 2));
    else {
      // Persist the snapshot before any writes. It includes all progress counters
      // because the compatible backfill also covers users who did not import Anki.
      const backupPath = resolve(output, `backup-${importId}.ejson`);
      if (!previousImport) {
        try { await writeFile(backupPath, BSON.EJSON.stringify({ content: current, progress: allProgress }, { relaxed: false }), { flag: "wx", mode: 0o600 }); }
        catch (error: any) { if (error.code !== "EEXIST") throw error; }
      }
      await db.collection("ANKI_IMPORTS").updateOne({ _id: importId }, { $setOnInsert: { userId, sourceHash: source.sourceHash, sourceName: source.sourceName, backupPath, createdAt: now }, $set: { status: "applying", summary } }, { upsert: true });
      for (const name of contentNames) {
        const docs = [...changed.get(name)!.values()];
        if (docs.length) await db.collection(name).bulkWrite(docs.map(doc => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })), { ordered: true });
      }
      const progress = db.collection("userprogresses");
      for (let offset = 0; offset < progressDocs.length; offset += 500) {
        const batch = progressDocs.slice(offset, offset + 500);
        // Insert-only scheduling: rerunning an import must not reset app reviews.
        await progress.bulkWrite(batch.map((doc: any) => ({ updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: doc }, upsert: true } })), { ordered: true });
      }
      await progress.updateMany({ failureIndex: { $exists: false } }, { $set: { failureIndex: 0 } });
      if (superseded.length) await progress.updateMany({ _id: { $in: superseded.map(p => p._id) } }, { $set: { supersededByAnki: true } });
      for (const [table, collection] of [["notes", "ANKI_NOTES"], ["cards", "ANKI_CARDS"], ["revlog", "ANKI_REVIEWS"]]) {
        const rows = tables[table];
        for (let offset = 0; offset < rows.length; offset += 1000) {
          await db.collection(collection).bulkWrite(rows.slice(offset, offset + 1000).map((row: any) => ({ updateOne: { filter: { _id: stableId(`anki-raw:${userId}:${table}:${row.guid || row.id}`) }, update: { $setOnInsert: { userId, importId, raw: row } }, upsert: true } })), { ordered: true });
        }
      }
      await db.collection("ANKI_IMPORTS").updateOne({ _id: importId }, { $set: { metadata: Object.fromEntries(Object.entries(tables).filter(([name]) => !["notes", "cards", "revlog"].includes(name))) } });
      await progress.createIndex({ userId: 1, itemType: 1, failureIndex: -1 });
      await progress.createIndex({ userId: 1, relationId: 1 });
      const actual = await progress.find({ _id: { $in: progressDocs.map((p: any) => p._id) } }).toArray();
      if (actual.length !== tables.cards.length || actual.some(p => !p.card || p.failureIndex < p.sourceFailureCount)) throw new Error("Card/counter verification failed");
      for (const [collection, count] of [["ANKI_NOTES", tables.notes.length], ["ANKI_CARDS", tables.cards.length], ["ANKI_REVIEWS", tables.revlog.length]] as const) {
        if (await db.collection(collection).countDocuments({ userId }) !== count) throw new Error(`${collection} count mismatch`);
      }
      // Save the exact post-import state for a rollback that refuses to overwrite
      // later app activity. No passwords or authentication data enter these files.
      const after = { content: Object.fromEntries(await Promise.all(contentNames.map(async name => [name, await db.collection(name).find({}).toArray()]))), progress: await progress.find({}).toArray() };
      await writeFile(resolve(output, `after-${importId}.ejson`), BSON.EJSON.stringify(after, { relaxed: false }), { mode: 0o600 });
      await db.collection("ANKI_IMPORTS").updateOne({ _id: importId }, { $set: { status: "complete", completedAt: new Date() } });
      await writeFile(resolve(output, "result.json"), JSON.stringify({ importId, backupPath, ...summary }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ status: "imported and verified", importId, backupPath, ...summary }, null, 2));
    }
  }
} finally { await client.close(); }
