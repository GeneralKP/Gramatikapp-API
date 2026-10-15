import { ObjectId } from 'mongodb';
import { getDb, type Database } from '../../lib/database.js';

const DAY_MS = 86_400_000;
export const STUDY_ACTIVITY_DAYS = 365;

export interface StudyActivityDay { date: string; count: number; }
export interface StudyActivity {
  startDate: string;
  endDate: string;
  days: StudyActivityDay[];
  totalReviews: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  dailyAverage: number;
}

/** Calendar dates deliberately use midnight, independently of scheduler rollover. */
export function studyActivityWindow(timezone: string, now: Date) {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 100 || !/^[A-Za-z_][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(timezone)) {
    throw new Error('Invalid timezone');
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    throw new Error('Invalid timezone');
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  const endDate = `${parts.year}-${parts.month}-${parts.day}`;
  // UTC arithmetic advances date labels, not elapsed local 24-hour periods.
  // It therefore includes leap days and remains dense across DST transitions.
  const endDay = Date.parse(`${endDate}T00:00:00.000Z`);
  const days = Array.from({ length: STUDY_ACTIVITY_DAYS }, (_, index) => ({
    date: new Date(endDay - (STUDY_ACTIVITY_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10), count: 0,
  }));
  return { timezone: formatter.resolvedOptions().timeZone, startDate: days[0].date, endDate, days };
}

export function summarizeStudyActivity(days: StudyActivityDay[]): StudyActivity {
  let totalReviews = 0, activeDays = 0, longestStreak = 0, run = 0;
  for (const day of days) {
    totalReviews += day.count;
    if (day.count > 0) { activeDays += 1; run += 1; longestStreak = Math.max(longestStreak, run); }
    else run = 0;
  }
  // A learner has the whole of today to continue a streak ending yesterday.
  let cursor = days.length - 1;
  if (days[cursor]?.count === 0) cursor -= 1;
  let currentStreak = 0;
  for (; cursor >= 0 && days[cursor].count > 0; cursor -= 1) currentStreak += 1;
  return { startDate: days[0].date, endDate: days[days.length - 1].date, days,
    totalReviews, activeDays, currentStreak, longestStreak, dailyAverage: totalReviews / days.length };
}

/** Read-only: receipts are the history; progress snapshots cannot reconstruct it. */
export async function loadStudyActivity(
  userId: ObjectId, timezone: string, now = new Date(), database?: Pick<Database, 'reviewEvents'>,
): Promise<StudyActivity> {
  const window = studyActivityWindow(timezone, now);
  const db = database ?? getDb();
  const counts = await db.reviewEvents.aggregate<{ _id: string; count: number }>([
    { $match: { userId, itemType: { $in: ['WORD', 'PHRASE'] }, reversedAt: null,
      // A small UTC margin covers every timezone offset, including midnight
      // transitions. The date-label match below sets the exact local boundary.
      reviewedAt: { $gte: new Date(Date.parse(`${window.startDate}T00:00:00.000Z`) - 2 * DAY_MS), $lte: now } } },
    { $group: { _id: { $dateToString: { date: '$reviewedAt', format: '%Y-%m-%d', timezone: window.timezone } }, count: { $sum: 1 } } },
    { $match: { _id: { $gte: window.startDate, $lte: window.endDate } } },
  ]).toArray();
  const byDate = new Map(counts.map(day => [day._id, day.count]));
  return summarizeStudyActivity(window.days.map(day => ({ ...day, count: byDate.get(day.date) ?? 0 })));
}
