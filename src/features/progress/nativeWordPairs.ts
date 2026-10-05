import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb, getDatabaseClient } from "../../lib/database.js";
import type { Word } from "../words/words.types.js";
import type { StudyCard, UserProgress } from "./progress.types.js";
import { initialScheduler } from "./scheduler.js";
import { withScheduler } from "./reviews.js";
import { isNewCard } from "./newWordOrder.js";

const seed = (id: ObjectId) => BigInt("0x" + createHash("sha256").update(id.toString()).digest("hex").slice(0, 15)).toString();
export function nativeWordPair(progress: UserProgress, spanish: Word, german: Word): [UserProgress, UserProgress] {
  const relationId = progress.relationId ?? progress.itemId;
  const readingId = new ObjectId(createHash("sha256").update(`word-recognition:${progress.userId}:${relationId}`).digest("hex").slice(0, 24));
  const gender = german.forms?.gender?.toLowerCase();
  const article = ({ der: "der", die: "die", das: "das", masculine: "der", feminine: "die", neuter: "das", m: "der", f: "die", n: "das" })[gender ?? ""];
  const expression = /^(der|die|das)\s+/i.test(german.word) || !article ? german.word : `${article} ${german.word.charAt(0).toUpperCase()}${german.word.slice(1)}`;
  const shared = { source: "APP" as const, sourceNoteGuid: `app-word:${progress.userId}:${relationId}`, notes: german.notes ?? "",
    examples: (german.examples ?? []).map((example, i) => spanish.examples?.[i] ? `${example} (${spanish.examples[i]})` : example), deck: "App", tags: [] };
  const study = (direction: StudyCard["direction"], id: ObjectId): StudyCard => ({ ...shared, sourceCardId: seed(id), direction,
    prompt: direction === "DE_ES" ? expression : spanish.word, answer: direction === "DE_ES" ? spanish.word : expression,
    acceptedAnswers: [direction === "DE_ES" ? spanish.word : expression] });
  const production = { ...progress, relationId, isNew: true, card: study("ES_DE", progress.itemId) };
  const reading: UserProgress = { _id: readingId, userId: progress.userId, itemId: readingId, itemType: "WORD", relationId,
    card: study("DE_ES", readingId), failureIndex: 0, totalReviews: 0, lapses: 0, isNew: true,
    ease: progress.scheduler?.options.initialEase ?? 2.5, interval: 0, repetitions: 0,
    nextDueDate: progress.nextDueDate, lastReviewed: null, createdAt: new Date() };
  reading.scheduler = initialScheduler(reading, progress.scheduler?.options, progress.scheduler?.timeZone, progress.scheduler?.rollover);
  return [reading, production];
}

/** Idempotently add recognition to unseen native words; keep the existing production record. */
export async function ensureNativeWordPairs(progress: UserProgress[]): Promise<UserProgress[]> {
  const candidates = progress.filter(p => p.itemType === "WORD" && !p.card && !p.suspended && !p.supersededByAnki && isNewCard(p));
  if (!candidates.length) return progress;
  const db = getDb();
  const relations = await db.relationsWordsEsDe.find({ _id: { $in: candidates.map(p => p.relationId ?? p.itemId) } }).toArray();
  const [spanish, german] = await Promise.all([
    db.wordsES.find({ _id: { $in: relations.map(r => r.main) } }).toArray(),
    db.wordsDE.find({ _id: { $in: relations.map(r => r.translated) } }).toArray(),
  ]);
  const additions: UserProgress[] = [], replacements = new Map<string, UserProgress>();
  for (const candidate of candidates) {
    const relation = relations.find(r => r._id.equals(candidate.relationId ?? candidate.itemId));
    const es = relation && spanish.find(w => w._id.equals(relation.main)), de = relation && german.find(w => w._id.equals(relation.translated));
    if (!es || !de) continue;
    const session = getDatabaseClient().startSession();
    try {
      const pair = await session.withTransaction(async () => {
        const stored = await db.progress.findOne({ _id: candidate._id, userId: candidate.userId }, { session });
        if (!stored) return null;
        if (stored.card) {
          const sibling = await db.progress.findOne({ userId: stored.userId, "card.sourceNoteGuid": stored.card.sourceNoteGuid, "card.direction": "DE_ES" }, { session });
          return sibling ? [sibling, stored] as const : null;
        }
        const current = await withScheduler(stored);
        if (!isNewCard(current) || current.suspended || current.supersededByAnki) return null;
        const [reading, production] = nativeWordPair(current, es, de);
        await db.progress.updateOne({ _id: stored._id }, { $set: { card: production.card, relationId: production.relationId, isNew: true } }, { session });
        await db.progress.updateOne({ _id: reading._id }, { $setOnInsert: reading }, { upsert: true, session });
        return [await db.progress.findOne({ _id: reading._id }, { session }), await db.progress.findOne({ _id: stored._id }, { session })] as const;
      });
      if (pair) { additions.push(pair[0]); replacements.set(candidate.itemId.toString(), pair[1]); }
    } finally { await session.endSession(); }
  }
  const existing = new Set(progress.map(p => p.itemId.toString()));
  return [...progress.map(p => replacements.get(p.itemId.toString()) ?? p), ...additions.filter(p => !existing.has(p.itemId.toString()))];
}
