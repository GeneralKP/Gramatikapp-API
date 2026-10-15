// dailyCounts already rolls child decks into their top-level parents.
export const introducedToday = (counts: Map<string, { new: number; review: number }>) => [...counts].filter(([deck]) => !deck.includes("::")).reduce((sum, [, value]) => sum + value.new, 0);
export function applyDailyLimit<T extends { scheduler?: any }>(cards: T[], limit: number): T[] {
  return cards.map(card => ({ ...card, scheduler: { ...card.scheduler, options: { ...card.scheduler.options, newPerDay: limit } } }));
}
