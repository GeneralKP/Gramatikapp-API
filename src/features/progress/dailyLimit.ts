import type { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { DEFAULT_OPTIONS } from "./scheduler.js";

export async function dailyNewLimit(userId: ObjectId) {
  const db = getDb();
  const user = await db.users.findOne({ _id: userId });
  if (user?.settings?.dailyNewCards !== undefined) return user.settings.dailyNewCards;
  const profile = await db.schedulerProfiles.findOne({ _id: userId });
  return profile?.defaultOptions.newPerDay ?? DEFAULT_OPTIONS.newPerDay;
}
// dailyCounts already rolls child decks into their top-level parents.
export const introducedToday = (counts: Map<string, { new: number; review: number }>) => [...counts].filter(([deck]) => !deck.includes("::")).reduce((sum, [, value]) => sum + value.new, 0);
export function applyDailyLimit<T extends { scheduler?: any }>(cards: T[], limit: number): T[] {
  return cards.map(card => ({ ...card, scheduler: { ...card.scheduler, options: { ...card.scheduler.options, newPerDay: limit } } }));
}
