import { ObjectId, type ClientSession } from "mongodb";
import { getDb, getDatabaseClient } from "../../lib/database.js";
import type { UserProgress } from "./progress.types.js";
import { DEFAULT_OPTIONS, DeckOptions, Grade, GRADES, initialScheduler, normalizeUnstudiedProgress, scheduleReview, studyDay, dateForStudyDay } from "./scheduler.js";
import { scheduleStudyReview, type StudyGrade } from "./studyScheduling.js";
import { isIntroductionFollowup, isNewCard } from "./newWordOrder.js";
import { introducedToday } from "./dailyLimit.js";

export interface SchedulerProfile {
  _id: ObjectId; timeZone: string; rollover: number; defaultOptions: DeckOptions;
  baselines?: { day: number; deck: string; new: number; review: number }[];
  createdAt: Date;
}
const schedulingFields = ["scheduler", "ease", "interval", "repetitions", "nextDueDate", "lastReviewed", "totalReviews", "lapses", "isNew", "lastReviewId", "suspended", "leech", "temporaryDueDate"] as const;
type Snapshot = Partial<Pick<UserProgress, typeof schedulingFields[number]>>;
export interface ReviewEvent {
  _id: ObjectId; userId: ObjectId; itemId: ObjectId; itemType: string; reviewId: string;
  grade: StudyGrade; reviewedAt: Date; reversedAt: Date | null;
  earlyReview: boolean;
  before: Snapshot; after: Snapshot; version: number;
  deck: string; day: number; newCount: number; reviewCount: number;
  siblings: { id: ObjectId; previous: Date | null; applied: Date }[];
  studySessionId?: string;
  syncedAt?: Date;
}
export class ReviewConflict extends Error {
  constructor(message: string, public progress: UserProgress, public code: string) { super(message); }
}
export async function withScheduler(progress: UserProgress, profile?: SchedulerProfile | null): Promise<UserProgress> {
  if (progress.scheduler) return normalizeUnstudiedProgress(progress);
  if (profile === undefined) profile = await getDb().schedulerProfiles.findOne({ _id: progress.userId });
  return { ...progress, scheduler: initialScheduler(progress, profile?.defaultOptions ?? DEFAULT_OPTIONS, profile?.timeZone ?? "Europe/Berlin", profile?.rollover ?? 4) };
}
const snapshot = (progress: UserProgress): Snapshot => Object.fromEntries(schedulingFields.filter(key => progress[key] !== undefined).map(key => [key, progress[key]]));
const commandId = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(value)) throw new Error("Invalid review ID");
};
export const deckName = (progress: UserProgress) => progress.card?.deck || "App";
export const deckAncestors = (deck: string) => deck.split("::").map((_, i, parts) => parts.slice(0, i + 1).join("::"));

export async function saveReview(userId: ObjectId, itemId: ObjectId, itemType: string, grade: StudyGrade, reviewId: string, expectedVersion?: number, earlyReview = false, failureAttemptId?: string, timing?: { reviewedAt: Date; studySessionId: string }) {
  commandId(reviewId);
  if (!([...GRADES, "REVISIT"] as string[]).includes(grade) || !["WORD", "PHRASE"].includes(itemType)) throw new Error("Invalid review");
  const db = getDb(), session = getDatabaseClient().startSession();
  try {
    return await session.withTransaction(async () => {
      const previous = await db.reviewEvents.findOne({ userId, reviewId }, { session });
      if (previous) {
        if (!previous.itemId.equals(itemId) || previous.grade !== grade || previous.itemType !== itemType || !!previous.earlyReview !== earlyReview) throw new Error("Review ID already used for a different answer");
        if (previous.reversedAt) throw new ReviewConflict("This review was undone. Submit a new review.", await db.progress.findOne({ userId, itemId }, { session }), "REVIEW_UNDONE");
        return { reviewId, progress: { ...await db.progress.findOne({ userId, itemId }, { session }), extraPractice: earlyReview } };
      }
      const stored = await db.progress.findOne({ userId, itemId }, { session });
      if (!stored || stored.itemType !== itemType || stored.supersededByAnki || stored.suspended) throw new Error("Study card not found or unavailable");
      if (expectedVersion !== undefined && (stored.scheduleVersion ?? 0) !== expectedVersion) throw new ReviewConflict("This card was reviewed in another session. Its latest saved review has been kept.", stored, "STALE_CARD");
      const profile = await db.schedulerProfiles.findOne({ _id: userId }, { session });
      const current = await withScheduler(stored, profile);
      if (current.itemType === "WORD" && current.card?.direction === "ES_DE" && isNewCard(current)) {
        const recognition = await db.progress.findOne({ userId, itemType: "WORD", "card.sourceNoteGuid": current.card.sourceNoteGuid,
          "card.direction": "DE_ES", supersededByAnki: { $ne: true } }, { session });
        if (recognition && isNewCard(await withScheduler(recognition, profile))) {
          throw new ReviewConflict("Read the German → Spanish card before typing this new word.", stored, "INTRODUCTION_REQUIRED");
        }
      }
      const now = timing?.reviewedAt ?? new Date();
      if (current.scheduler.phase === "NEW") {
        // A write to the shared account serializes competing devices' quota
        // checks inside MongoDB's retryable transaction (avoids write skew).
        const account = await db.users.findOne({ _id: userId }, { session });
        if (account) {
          await db.users.updateOne({ _id: userId }, { $inc: { studySyncVersion: 1 } }, { session });
          const limit = account.settings?.dailyNewCards ?? profile?.defaultOptions.newPerDay ?? DEFAULT_OPTIONS.newPerDay;
          const counts = await dailyCounts(userId, studyDay(now, current.scheduler.timeZone, current.scheduler.rollover), profile, session);
          if (introducedToday(counts) >= limit) throw new ReviewConflict("The daily new-card limit has been reached on another session. Your mistakes are retained; this new card can be introduced on the next study day.", stored, "DAILY_NEW_LIMIT");
        }
      }
      let next: ReturnType<typeof scheduleStudyReview>;
      try { next = scheduleStudyReview(current, grade, now, earlyReview); }
      catch (error) {
        if (grade === "REVISIT") throw new ReviewConflict(error instanceof Error ? error.message : "Revisit is no longer available.", stored, "REVISIT_UNAVAILABLE");
        throw error;
      }
      const { delaySeconds, ...update } = next;
      const threshold = current.scheduler.options.leechThreshold;
      const becameLeech = next.lapses > (stored.lapses ?? 0) && threshold > 0 && next.lapses >= threshold && (next.lapses - threshold) % Math.max(1, Math.ceil(threshold / 2)) === 0;
      const after: UserProgress = { ...current, ...update, lastReviewId: reviewId, scheduleVersion: (stored.scheduleVersion ?? 0) + 1,
        ...(becameLeech ? { leech: true, ...(current.scheduler.options.leechSuspend ? { suspended: true } : {}) } : {}) };
      const isExtraReview = !!current.temporaryDueDate && current.nextDueDate > now || grade === "REVISIT" && current.nextDueDate > now;
      const siblings: ReviewEvent["siblings"] = [];
      if (!isExtraReview && grade !== "REVISIT" && current.card?.sourceNoteGuid && (current.scheduler.options.buryNew || current.scheduler.options.buryReviews || current.scheduler.options.buryInterday)) {
        const candidates = await db.progress.find({ userId, "card.sourceNoteGuid": current.card.sourceNoteGuid, itemId: { $ne: itemId }, suspended: { $ne: true } }, { session }).toArray();
        const until = dateForStudyDay(studyDay(now, current.scheduler.timeZone, current.scheduler.rollover) + 1, current.scheduler.timeZone, current.scheduler.rollover);
        for (const sibling of candidates) {
          // The first production attempt belongs to the same introduction. It
          // must remain available after recognition, even with bury-new enabled.
          if (isIntroductionFollowup(current, sibling)) continue;
          const state = sibling.scheduler ?? initialScheduler(sibling, current.scheduler.options, current.scheduler.timeZone, current.scheduler.rollover);
          const shouldBury = state.phase === "NEW" ? current.scheduler.options.buryNew : state.phase === "REVIEW" ? current.scheduler.options.buryReviews : state.queue === "DAY" && current.scheduler.options.buryInterday;
          if (!shouldBury || sibling.buriedUntil && sibling.buriedUntil >= until) continue;
          siblings.push({ id: sibling._id, previous: sibling.buriedUntil ?? null, applied: until });
          await db.progress.updateOne({ _id: sibling._id }, { $set: { buriedUntil: until } }, { session });
        }
      }
      const event: ReviewEvent = { _id: new ObjectId(), userId, itemId, itemType, reviewId, grade, earlyReview, reviewedAt: now, reversedAt: null,
        before: snapshot(current), after: snapshot(after), version: after.scheduleVersion,
        deck: deckName(current), day: studyDay(now, current.scheduler.timeZone, current.scheduler.rollover),
        newCount: !isExtraReview && current.scheduler.phase === "NEW" ? 1 : 0,
        reviewCount: !isExtraReview && (current.scheduler.phase === "REVIEW" || current.scheduler.queue === "DAY" && current.scheduler.phase !== "NEW") ? 1 : 0, siblings,
        ...(timing ? { studySessionId: timing.studySessionId, syncedAt: new Date() } : {}) };
      await db.reviewEvents.insertOne(event, { session });
      const unset = Object.fromEntries(schedulingFields.filter(key => after[key] === undefined).map(key => [key, "" as const]));
      await db.progress.updateOne({ _id: stored._id }, { $set: { ...snapshot(after), scheduleVersion: after.scheduleVersion, updatedAt: now }, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { session });
      if (grade === "REVISIT") {
        // Revisit is a separate mistake from Check. The review command itself
        // deduplicates retries, including responses lost after the commit.
        const attemptId = timing ? `revisit_${reviewId}` : reviewId;
        commandId(attemptId);
        await db.progress.updateOne({ _id: stored._id, failureAttemptIds: { $ne: attemptId } }, { $inc: { failureIndex: 1 }, $addToSet: { failureAttemptIds: attemptId }, $set: { lastFailedAt: now } }, { session });
      }
      return { reviewId, progress: { ...await db.progress.findOne({ _id: stored._id }, { session }), extraPractice: earlyReview } };
    });
  } finally { await session.endSession(); }
}

export async function undoReview(userId: ObjectId, reviewId: string) {
  commandId(reviewId);
  const db = getDb(), session = getDatabaseClient().startSession();
  try {
    return await session.withTransaction(async () => {
      const event = await db.reviewEvents.findOne({ userId, reviewId }, { session });
      if (!event) throw new Error("Review not found");
      const progress = await db.progress.findOne({ userId, itemId: event.itemId }, { session });
      if (!progress) throw new Error("Study card not found");
      if (event.reversedAt) return { reviewId, progress: { ...progress, extraPractice: !!event.earlyReview } };
      if (progress.lastReviewId !== reviewId) throw new Error("A newer review exists for this card. Undo that review first.");
      const unset = Object.fromEntries(schedulingFields.filter(key => !(key in event.before)).map(key => [key, "" as const]));
      // Failure fields are deliberately absent from both snapshots and updates.
      await db.progress.updateOne({ _id: progress._id }, { $set: { ...event.before, updatedAt: new Date() }, $inc: { scheduleVersion: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { session });
      for (const sibling of event.siblings) {
        await db.progress.updateOne({ _id: sibling.id, buriedUntil: sibling.applied }, { $set: { buriedUntil: sibling.previous } }, { session });
      }
      await db.reviewEvents.updateOne({ _id: event._id }, { $set: { reversedAt: new Date() } }, { session });
      return { reviewId, progress: { ...await db.progress.findOne({ _id: progress._id }, { session }), extraPractice: !!event.earlyReview } };
    });
  } finally { await session.endSession(); }
}

export async function dailyCounts(userId: ObjectId, day: number, profile?: SchedulerProfile | null, session?: ClientSession) {
  const counts = new Map<string, { new: number; review: number }>();
  for (const entry of profile?.baselines ?? []) if (entry.day === day) counts.set(entry.deck, { new: entry.new, review: entry.review });
  const events = await getDb().reviewEvents.aggregate<{ _id: string; new: number; review: number }>([
    { $match: { userId, day, reversedAt: null } },
    { $group: { _id: "$deck", new: { $sum: "$newCount" }, review: { $sum: "$reviewCount" } } },
  ], { session }).toArray();
  for (const event of events) for (const deck of deckAncestors(event._id)) {
    const prior = counts.get(deck) ?? { new: 0, review: 0 };
    counts.set(deck, { new: prior.new + event.new, review: prior.review + event.review });
  }
  return counts;
}
