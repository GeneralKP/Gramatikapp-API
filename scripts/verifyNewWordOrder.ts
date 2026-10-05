import "dotenv/config";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { connectDatabase, closeDatabase } from "../src/lib/database.js";
import { withScheduler, dailyCounts } from "../src/features/progress/reviews.js";
import { studyDay } from "../src/features/progress/scheduler.js";
import { selectStudyQueue } from "../src/features/progress/studyQueue.js";
import { newCardGroups } from "../src/features/progress/newWordOrder.js";
import { noteContent, studyCard } from "./lib/anki.js";

const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const email = option("--email"), exportPath = option("--export"), output = option("--output");
if (!email || !exportPath) throw new Error("Usage: tsx scripts/verifyNewWordOrder.ts --email ACCOUNT --export EXPORT.json [--output private-report.json]");
const tables = JSON.parse(await readFile(resolve(exportPath), "utf8")).tables;
const sourceCards = new Map<string, any>(tables.cards.map((p: any) => [String(p.id), p]));
const sourceNotes = new Map<number, any>(tables.notes.map((p: any) => [p.id, p]));
const db = await connectDatabase();
try {
  const user = await db.users.findOne({ email });
  assert.ok(user, "account exists");
  const stored = await db.progress.find({ userId: user._id, itemType: "WORD", "card.source": "ANKI" }).toArray();
  const profile = await db.schedulerProfiles.findOne({ _id: user._id });
  const progress = await Promise.all(stored.map(p => withScheduler(p, profile)));
  const native = await db.progress.find({ userId: user._id, itemType: "WORD", "card.source": "APP" }).toArray();
  const all = [...progress, ...await Promise.all(native.map(p => withScheduler(p, profile)))];
  const unseen = progress.filter(p => p.scheduler!.phase === "NEW");
  const notes = new Map<string, typeof progress>();
  for (const p of progress) notes.set(p.card!.sourceNoteGuid, [...(notes.get(p.card!.sourceNoteGuid) ?? []), p]);
  for (const p of unseen) {
    const source = sourceCards.get(p.card!.sourceCardId);
    assert.ok(source, "unseen card retains its source card identity");
    const note = sourceNotes.get(source.nid);
    const expected = studyCard(source, note, tables, noteContent(note, tables));
    assert.equal(p.card!.direction, expected.direction);
    assert.equal(p.card!.prompt, expected.prompt, "full German/Spanish prompt retained");
    assert.equal(p.card!.answer, expected.answer, "full expression, including article/preposition, retained");
    assert.deepEqual(p.card!.acceptedAnswers, expected.acceptedAnswers);
    assert.equal(notes.get(p.card!.sourceNoteGuid)!.length, 2, "every unseen imported word has both directions");
  }
  const now = new Date();
  const introductions = newCardGroups(all, all.filter(p => !p.suspended && (!p.buriedUntil || p.buriedUntil <= now))).flat();
  for (const siblings of notes.values()) {
    if (!siblings.every(p => p.scheduler!.phase === "NEW")) continue;
    const reading = siblings.find(p => p.card!.direction === "DE_ES")!;
    const typing = siblings.find(p => p.card!.direction === "ES_DE")!;
    const index = introductions.findIndex(p => p.itemId.equals(reading.itemId));
    assert.ok(index >= 0);
    assert.ok(introductions[index + 1]?.itemId.equals(typing.itemId), "all fully unseen words are adjacent reading → typing pairs");
  }
  const nativeNotes = new Map<string, typeof native>();
  for (const p of native) nativeNotes.set(p.card!.sourceNoteGuid, [...(nativeNotes.get(p.card!.sourceNoteGuid) ?? []), p]);
  for (const siblings of nativeNotes.values()) {
    if (!siblings.every(p => p.scheduler!.phase === "NEW")) continue;
    const reading = siblings.find(p => p.card!.direction === "DE_ES")!;
    const typing = siblings.find(p => p.card!.direction === "ES_DE")!;
    const index = introductions.findIndex(p => p.itemId.equals(reading.itemId));
    assert.ok(index >= 0 && introductions[index + 1]?.itemId.equals(typing.itemId), "unseen native words follow the same introduction order");
  }
  const counts = await dailyCounts(user._id, studyDay(now, profile?.timeZone ?? "Europe/Berlin", profile?.rollover ?? 4), profile);
  const live = selectStudyQueue(all, counts, now, 50, 10);
  const report = { auditedAt: now.toISOString(), account: email, importedWordCards: stored.length,
    unseenCards: unseen.length, fullyUnseenWordPairs: [...notes.values()].filter(p => p.every(c => c.scheduler!.phase === "NEW")).length,
    partiallyIntroducedWords: [...notes.values()].filter(p => p.some(c => c.scheduler!.phase === "NEW") && p.some(c => c.scheduler!.phase !== "NEW")).length,
    allUnseenSourceExpressionsPreserved: true, allUnseenPairsReadingThenTyping: true, databaseWrites: 0,
    nativeUnseenWordPairs: [...nativeNotes.values()].filter(p => p.every(c => c.scheduler!.phase === "NEW")).length,
    nextBatchNewCards: live.filter(p => p.scheduler!.phase === "NEW").map(p => ({ direction: p.card!.direction, prompt: p.card!.prompt, answer: p.card!.answer })),
  };
  if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); }
  console.log(JSON.stringify(report, null, 2));
} finally { await closeDatabase(); }
