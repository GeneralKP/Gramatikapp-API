import "dotenv/config";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BSON, MongoClient, ObjectId } from "mongodb";
import { initialScheduler, studyDay } from "../src/features/progress/scheduler.js";
import { collectionConfig, dueDate } from "./lib/anki.js";
import { deckOptions, protobufFields } from "./lib/ankiOptions.js";

const args = process.argv.slice(2), value = (key: string, fallback?: string) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const email = value("--email"), apply = args.includes("--apply"), rollback = args.includes("--rollback");
if (!email) throw new Error("Usage: migrateAnkiScheduler.ts --email ACCOUNT [--timezone Europe/Berlin] [--output private/directory] [--apply] [--rollback]");
const output = resolve(value("--output", "../.local/anki-import")!);
const uri = process.env.MONGODB_URI || `mongodb+srv://${process.env.DB_USER}:${process.env.DB_USER_PASSWORD}@${process.env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
const client = await new MongoClient(uri).connect();
try {
  const db = client.db("gramatikapp"), user = await db.collection("users").findOne({ email }, { projection: { _id: 1 } });
  if (!user) throw new Error("Account not found");
  const userId = user._id, progress = db.collection("userprogresses"), profiles = db.collection("schedulerprofiles");
  const backupPath = resolve(output, `scheduler-v1-${userId}.ejson`);
  if (rollback) {
    const backup = BSON.EJSON.parse(await readFile(backupPath, "utf8"));
    const current = await progress.find({ userId }).toArray();
    if (current.length !== backup.progress.length || await db.collection("reviewevents").countDocuments({ userId })) throw new Error("Rollback refused: later study activity exists");
    const byId = new Map(current.map(p => [p._id.toString(), p]));
    for (const before of backup.progress) {
      const after = byId.get(before._id.toString());
      if (!after || (after.scheduleVersion ?? 0) !== (before.scheduleVersion ?? 0) || after.nextDueDate.getTime() !== before.nextDueDate.getTime()) throw new Error("Rollback refused: later review activity exists");
    }
    if (apply) {
      const session = client.startSession();
      try { await session.withTransaction(async () => {
        for (const before of backup.progress) {
          const set: any = {}, unset: any = {};
          for (const key of ["scheduler", "scheduleVersion"]) if (before[key] === undefined) unset[key] = ""; else set[key] = before[key];
          await progress.updateOne({ _id: before._id, scheduleVersion: before.scheduleVersion ?? 0 }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { session });
        }
        if (backup.profile) await profiles.replaceOne({ _id: userId }, backup.profile, { upsert: true, session });
        else await profiles.deleteOne({ _id: userId }, { session });
      }); } finally { await session.endSession(); }
    }
    console.log(JSON.stringify({ status: apply ? "scheduler rollback applied" : "scheduler rollback preflight passed", cards: backup.progress.length }));
  } else {
    const manifest = await db.collection("ANKI_IMPORTS").findOne({ userId, status: "complete" });
    if (!manifest?.metadata) throw new Error("No complete Anki import metadata found");
    const tables = manifest.metadata, config = collectionConfig(tables.config);
    if (config.fsrs) throw new Error("This migration targets classic Anki scheduling; FSRS is enabled in the source");
    const zone = value("--timezone", manifest.summary.timezone || "Europe/Berlin")!, rollover = config.rollover ?? 4;
    const presets = new Map(tables.deck_config.map((r: any) => [r.id, deckOptions(r.config, config.collapseTime ?? 1200)]));
    const byDeck = new Map<number, any>(), baselines: any[] = [];
    for (const deck of tables.decks) {
      const kind = protobufFields(deck.kind), normal = kind.get(1);
      if (!Buffer.isBuffer(normal)) throw new Error("Filtered decks need a separate migration");
      const decoded = protobufFields({ base64: normal.toString("base64") }), options: any = { ...presets.get(decoded.get(1) as number) as any };
      if (decoded.has(6)) options.reviewsPerDay = decoded.get(6);
      if (decoded.has(7)) options.newPerDay = decoded.get(7);
      byDeck.set(deck.id, options);
      const common = protobufFields(deck.common);
      if (common.has(3)) {
        const day = studyDay(dueDate({ queue: 3, due: common.get(3) }, tables.col[0], config, zone, new Date()), zone, rollover);
        baselines.push({ day, deck: deck.name.replace(/\u001f/g, "::"), new: Number(common.get(4) ?? 0), review: Number(common.get(5) ?? 0) });
      }
    }
    const docs = await progress.find({ userId }).toArray(), oldProfile = await profiles.findOne({ _id: userId });
    const targets = docs.filter(p => !p.scheduler);
    const profile = { _id: userId, timeZone: zone, rollover, defaultOptions: presets.values().next().value, baselines, createdAt: new Date() };
    const phases: Record<string, number> = {};
    for (const p of targets) {
      const state = initialScheduler(p as any, byDeck.get(p.anki?.odid || p.anki?.did) ?? profile.defaultOptions, zone, rollover);
      phases[state.phase] = (phases[state.phase] ?? 0) + 1;
    }
    if (apply && targets.length) {
      await mkdir(output, { recursive: true });
      try { await writeFile(backupPath, BSON.EJSON.stringify({ userId, profile: oldProfile, progress: docs }, { relaxed: false }), { flag: "wx", mode: 0o600 }); }
      catch (error: any) { if (error.code !== "EEXIST") throw error; }
      if (!oldProfile) await profiles.insertOne(profile);
      for (let offset = 0; offset < targets.length; offset += 500) {
        const batch = targets.slice(offset, offset + 500);
        await progress.bulkWrite(batch.map(p => ({ updateOne: {
          filter: { _id: p._id, scheduler: { $exists: false }, nextDueDate: p.nextDueDate,
            totalReviews: p.totalReviews ?? { $exists: false }, scheduleVersion: p.scheduleVersion ?? { $exists: false } },
          update: { $set: { scheduler: initialScheduler(p as any, byDeck.get(p.anki?.odid || p.anki?.did) ?? profile.defaultOptions, zone, rollover), scheduleVersion: p.scheduleVersion ?? 0 } },
        } })), { ordered: true });
      }
      // Changed cards are skipped by the compare-and-set filters, then retried
      // from their latest state rather than overwriting an in-flight answer.
      const skipped = await progress.find({ userId, scheduler: { $exists: false } }).toArray();
      for (const latest of skipped) {
        await progress.updateOne({ _id: latest._id, scheduler: { $exists: false }, nextDueDate: latest.nextDueDate,
          totalReviews: latest.totalReviews ?? { $exists: false }, scheduleVersion: latest.scheduleVersion ?? { $exists: false } },
          { $set: { scheduler: initialScheduler(latest as any, byDeck.get(latest.anki?.odid || latest.anki?.did) ?? profile.defaultOptions, zone, rollover), scheduleVersion: latest.scheduleVersion ?? 0 } });
      }
      const after = await progress.find({ userId }).toArray();
      for (const original of docs) {
        const current = after.find(p => p._id.equals(original._id))!;
        assert.ok(current.scheduler);
        if ((current.scheduleVersion ?? 0) === (original.scheduleVersion ?? 0)) assert.equal(current.nextDueDate.getTime(), original.nextDueDate.getTime(), "Migration changed a due date");
        assert.ok((current.failureIndex ?? 0) >= (original.failureIndex ?? 0), "Migration lost a failure");
      }
    }
    console.log(JSON.stringify({ status: apply ? "scheduler migration verified" : "scheduler migration dry run", cards: docs.length, toMigrate: targets.length, phases, timeZone: zone, rollover, defaultOptions: profile.defaultOptions, baselines }, null, 2));
  }
} finally { await client.close(); }
