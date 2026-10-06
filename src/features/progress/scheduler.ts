import { createHash } from "node:crypto";
import type { UserProgress } from "./progress.types.js";

export type Grade = "AGAIN" | "HARD" | "GOOD" | "EASY";
export const GRADES: Grade[] = ["AGAIN", "HARD", "GOOD", "EASY"];
export type Phase = "NEW" | "LEARNING" | "REVIEW" | "RELEARNING";
export interface DeckOptions {
  learningSteps: number[]; relearningSteps: number[];
  graduatingGood: number; graduatingEasy: number; initialEase: number;
  hardMultiplier: number; easyMultiplier: number; intervalMultiplier: number;
  lapseMultiplier: number; minimumLapseInterval: number; maximumInterval: number;
  newPerDay: number; reviewsPerDay: number; learnAheadSeconds: number;
  buryNew: boolean; buryReviews: boolean; buryInterday: boolean;
  newMix: number; interdayMix: number; reviewOrder: number; newOrder: number;
  leechThreshold: number; leechSuspend: boolean;
}
export const DEFAULT_OPTIONS: DeckOptions = {
  learningSteps: [1, 10], relearningSteps: [10], graduatingGood: 1, graduatingEasy: 4,
  initialEase: 2.5, hardMultiplier: 1.2, easyMultiplier: 1.3, intervalMultiplier: 1,
  lapseMultiplier: 0, minimumLapseInterval: 1, maximumInterval: 36500,
  newPerDay: 20, reviewsPerDay: 200, learnAheadSeconds: 1200,
  buryNew: false, buryReviews: false, buryInterday: false,
  newMix: 0, interdayMix: 0, reviewOrder: 0, newOrder: 0,
  leechThreshold: 8, leechSuspend: false,
};
export interface CardState {
  phase: Phase; remainingSteps: number; scheduledSeconds: number;
  interval: number; ease: number; lapses: number; elapsedDays?: number;
}
export interface SchedulerState extends CardState {
  version: 1; queue: "NEW" | "MINUTE" | "DAY"; options: DeckOptions;
  timeZone: string; rollover: number;
}
const DAY = 86400, f = Math.fround;
const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));

// Rust rand's seeded StdRng uses PCG32 for its key and ChaCha12 for its stream.
// Matching the stream lets previews, retries and the Anki reference use the same
// interval jitter for a card at a given lifetime review count.
function fuzzWord(seed: bigint): number {
  const rotateRight = (x: number, n: number) => ((x >>> n) | (x << ((32 - n) & 31))) >>> 0;
  const key: number[] = [];
  for (let i = 0; i < 8; i++) {
    seed = BigInt.asUintN(64, seed * 6364136223846793005n + 11634580027462260723n);
    key.push(rotateRight(Number(BigInt.asUintN(32, ((seed >> 18n) ^ seed) >> 27n)), Number(seed >> 59n)));
  }
  const original = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...key, 0, 0, 0, 0];
  const x = [...original];
  const rot = (v: number, n: number) => ((v << n) | (v >>> (32 - n))) >>> 0;
  const quarter = (a: number, b: number, c: number, d: number) => {
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rot(x[d] ^ x[a], 16);
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rot(x[b] ^ x[c], 12);
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rot(x[d] ^ x[a], 8);
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rot(x[b] ^ x[c], 7);
  };
  for (let i = 0; i < 6; i++) {
    quarter(0, 4, 8, 12); quarter(1, 5, 9, 13); quarter(2, 6, 10, 14); quarter(3, 7, 11, 15);
    quarter(0, 5, 10, 15); quarter(1, 6, 11, 12); quarter(2, 7, 8, 13); quarter(3, 4, 9, 14);
  }
  return (x[0] + original[0]) >>> 0;
}
export function fuzzFactor(seed: bigint): number { return (fuzzWord(seed) >>> 9) / 8388608; }

function jitter(interval: number, minimum: number, maximum: number, factor: number | null) {
  maximum = Math.max(1, maximum); minimum = clamp(minimum, 1, maximum);
  if (factor === null) return clamp(Math.round(interval), minimum, maximum);
  interval = f(clamp(interval, minimum, maximum));
  let delta = 0;
  if (interval >= 2.5) {
    delta = 1;
    for (const [start, end, rate] of [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]]) {
      delta = f(delta + f(f(rate) * f(Math.max(0, Math.min(interval, end) - start))));
    }
  }
  const lower = clamp(Math.round(f(interval - delta)), minimum, maximum);
  let upper = clamp(Math.round(f(interval + delta)), minimum, maximum);
  if (upper === lower && upper > 2 && upper < maximum) upper++;
  return Math.floor(f(lower + f(factor * (1 + upper - lower))));
}

/** Four classic Anki transitions. Calendar conversion is handled separately. */
export function nextStates(current: CardState, options: DeckOptions, factor: number | null): CardState[] {
  const review = (interval: number, ease = current.ease, lapses = current.lapses): CardState =>
    ({ phase: "REVIEW", remainingSteps: 0, scheduledSeconds: 0, interval, ease: f(ease), lapses });
  const interval = (value: number, minimum = 1, fuzz = true) => jitter(f(value), minimum, options.maximumInterval, fuzz ? factor : null);
  const lapseInterval = () => interval(f(Math.max(1, current.interval) * f(options.lapseMultiplier)), options.minimumLapseInterval);
  if (current.phase === "REVIEW") {
    const base = Math.max(1, current.interval), late = (current.elapsedDays ?? base) - current.interval;
    let hard: number, good: number, easy: number;
    const scaled = (value: number, minimum: number, fuzz = true) => interval(f(value * f(options.intervalMultiplier)), minimum, fuzz);
    if (late < 0) {
      const elapsed = Math.max(0, current.elapsedDays ?? 0);
      hard = scaled(Math.max(f(elapsed * f(options.hardMultiplier)), f(base * f(f(options.hardMultiplier) / 2))), 0, false);
      good = scaled(Math.max(f(elapsed * f(current.ease)), base), 0, false);
      const bonus = f(f(options.easyMultiplier) - f(f(f(options.easyMultiplier) - 1) / 2));
      easy = scaled(f(Math.max(f(elapsed * f(current.ease)), base) * bonus), 0, false);
    } else {
      hard = scaled(f(base * f(options.hardMultiplier)), options.hardMultiplier <= 1 ? 0 : current.interval + 1);
      good = scaled(f(f(base + f(late / 2)) * f(current.ease)), options.hardMultiplier <= 1 ? current.interval + 1 : hard + 1);
      easy = scaled(f(f(f(base + late) * f(current.ease)) * f(options.easyMultiplier)), good + 1);
    }
    const again = review(lapseInterval(), Math.max(1.3, f(f(current.ease) - f(0.2))), current.lapses + 1);
    if (options.relearningSteps.length) Object.assign(again, { phase: "RELEARNING", remainingSteps: options.relearningSteps.length, scheduledSeconds: Math.trunc(f(f(options.relearningSteps[0]) * 60)) });
    return [again, review(hard, Math.max(1.3, f(f(current.ease) - f(0.15)))), review(good), review(easy, f(f(current.ease) + f(0.15)))];
  }
  const relearning = current.phase === "RELEARNING";
  const steps = relearning ? options.relearningSteps : options.learningSteps;
  const remaining = current.phase === "NEW" ? steps.length : current.remainingSteps;
  const index = Math.min(Math.max(0, steps.length - remaining % 1000), Math.max(0, steps.length - 1));
  const seconds = (i: number) => steps[i] === undefined ? undefined : Math.trunc(f(f(steps[i]) * 60));
  const roundedDays = (secs: number) => secs > DAY ? Math.round(f(secs / DAY)) * DAY : secs;
  const first = seconds(0), present = seconds(index);
  const hardDelay = present === undefined ? undefined : index === 0
    ? roundedDays(seconds(1) === undefined ? Math.min(Math.floor(present * 1.5), present + DAY) : Math.floor((present + seconds(1)!) / 2)) : present;
  const graduated = (easy = false) => relearning
    ? review(easy ? current.interval + 1 : current.interval)
    : review(interval(easy ? options.graduatingEasy : options.graduatingGood), options.initialEase, 0);
  const learn = (delay: number | undefined, left: number, again = false): CardState => {
    if (delay === undefined) return graduated();
    return { phase: relearning ? "RELEARNING" : "LEARNING", remainingSteps: left,
      scheduledSeconds: delay, interval: relearning ? again ? lapseInterval() : current.interval : 0,
      ease: relearning ? f(current.ease) : 2.5, lapses: relearning ? current.lapses : 0 };
  };
  return [learn(first, steps.length, true), learn(hardDelay, remaining), learn(seconds(index + 1), Math.max(0, steps.length - index - 1)), graduated(true)];
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(date: Date, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(zone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, Number(p.value)]));
}
export function studyDay(now: Date, zone: string, rollover: number): number {
  const p = localParts(now, zone);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000) - (p.hour < rollover ? 1 : 0);
}
export function dateForStudyDay(day: number, zone: string, rollover: number): Date {
  const localStamp = day * 86400000 + rollover * 3600000;
  let stamp = localStamp;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(stamp), zone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    stamp += localStamp - represented;
  }
  return new Date(stamp);
}

export function initialScheduler(progress: UserProgress, options = DEFAULT_OPTIONS, timeZone = "Europe/Berlin", rollover = 4): SchedulerState {
  const raw = progress.anki;
  // Old app reviews already changed live dates: never restore the source snapshot
  // over them. Their current state is preserved as a review/new state.
  const untouched = raw && (progress.totalReviews ?? raw.reps) === raw.reps && (!progress.updatedAt || progress.updatedAt <= progress.createdAt || !progress.lastReviewed || progress.lastReviewed <= progress.createdAt);
  const phase: Phase = untouched ? (["NEW", "LEARNING", "REVIEW", "RELEARNING"] as Phase[])[raw.type] : progress.isNew || !progress.lastReviewed && progress.interval === 0 ? "NEW" : "REVIEW";
  const steps = phase === "RELEARNING" ? options.relearningSteps : options.learningSteps;
  const left = untouched ? raw.left % 1000 : 0;
  return { version: 1, phase, remainingSteps: left, scheduledSeconds: steps.length ? Math.trunc((steps[Math.min(Math.max(0, steps.length - left), steps.length - 1)] || 0) * 60) : 0,
    interval: progress.interval, ease: progress.ease, lapses: progress.lapses ?? 0,
    queue: phase === "NEW" ? "NEW" : untouched && raw.queue === 1 ? "MINUTE" : "DAY", options: { ...options }, timeZone, rollover };
}

export function schedulerSeed(progress: UserProgress): bigint {
  return progress.card?.sourceCardId ? BigInt(progress.card.sourceCardId) : BigInt("0x" + createHash("sha256").update(progress.itemId.toString()).digest("hex").slice(0, 15));
}
export function scheduleReview(progress: UserProgress, grade: Grade, now: Date, earlyReview = false) {
  const current = progress.scheduler ?? initialScheduler(progress);
  const today = studyDay(now, current.timeZone, current.rollover);
  // Normal Anki review treats a future review as due today. Filtered/custom
  // study preserves the future due day and applies the early-review rules.
  const originalDueDay = studyDay(progress.nextDueDate, current.timeZone, current.rollover);
  const dueDay = earlyReview ? originalDueDay : Math.min(today, originalDueDay);
  const seedId = schedulerSeed(progress);
  const factor = fuzzFactor(seedId + BigInt(progress.totalReviews ?? 0));
  const state = nextStates({ ...current, elapsedDays: Math.max(0, current.interval + today - dueDay) }, current.options, factor)[GRADES.indexOf(grade)];
  if (!state) throw new Error("Invalid review grade");
  let queue: SchedulerState["queue"], nextDueDate: Date, delaySeconds: number;
  if (state.phase === "REVIEW") {
    queue = "DAY"; delaySeconds = state.interval * DAY;
    nextDueDate = dateForStudyDay(today + state.interval, current.timeZone, current.rollover);
  } else {
    const untilRollover = (dateForStudyDay(today + 1, current.timeZone, current.rollover).getTime() - now.getTime()) / 1000;
    delaySeconds = state.scheduledSeconds;
    if (delaySeconds >= untilRollover) {
      queue = "DAY";
      // A step crossing rollover becomes an integer day interval in Anki.
      const days = Math.floor((delaySeconds - untilRollover) / DAY) + 1;
      nextDueDate = dateForStudyDay(today + days, current.timeZone, current.rollover);
      delaySeconds = days * DAY;
    } else {
      queue = "MINUTE";
      const extra = Math.floor(Math.min(f(delaySeconds * 0.25), 300));
      const jitterSeconds = extra ? Number((BigInt(fuzzWord(seedId + BigInt(progress.totalReviews ?? 0))) * BigInt(extra)) >> 32n) : 0;
      nextDueDate = new Date(Math.floor(now.getTime() / 1000) * 1000 + (delaySeconds + jitterSeconds) * 1000);
    }
  }
  const scheduler: SchedulerState = { ...current, ...state, queue };
  delete scheduler.elapsedDays;
  return { scheduler, ease: state.ease, interval: state.interval, repetitions: grade === "AGAIN" ? 0 : progress.repetitions + 1,
    lapses: state.lapses, totalReviews: (progress.totalReviews ?? 0) + 1, isNew: false,
    nextDueDate, lastReviewed: now, delaySeconds };
}

export function reviewOptions(progress: UserProgress, now = new Date(), earlyReview = false) {
  return GRADES.map(grade => {
    const next = scheduleReview(progress, grade, now, earlyReview);
    return { grade, delaySeconds: next.delaySeconds, nextDueDate: next.nextDueDate.toISOString(), phase: next.scheduler.phase };
  });
}
