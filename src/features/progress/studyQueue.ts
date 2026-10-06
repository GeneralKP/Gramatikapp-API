import { effectiveDueDate } from "./studyScheduling.js";
import type { UserProgress } from "./progress.types.js";
import { deckName, deckAncestors } from "./reviews.js";
import { newCardGroups } from "./newWordOrder.js";

const mix = <T>(first: T[], second: T[]) => {
  const result: T[] = [], total = first.length + second.length;
  let a = 0, b = 0;
  for (let i = 0; i < total; i++) {
    if (b < second.length && (a >= first.length || b < Math.floor((i + 1) * second.length / total))) result.push(second[b++]);
    else result.push(first[a++]);
  }
  return result;
};

export function selectStudyQueue(progress: UserProgress[], counts: Map<string, { new: number; review: number }>, now: Date, dueLimit: number, newLimit: number, allowPartialIntroduction = false) {
  const available = progress.filter(p => !p.suspended && !p.supersededByAnki && (!p.buriedUntil || p.buriedUntil <= now));
  const temporary = available.filter(p => p.temporaryDueDate && p.temporaryDueDate <= now).sort((a,b) => effectiveDueDate(a).getTime() - effectiveDueDate(b).getTime());
  const minute = available.filter(p => p.scheduler.queue === "MINUTE" && p.nextDueDate <= now).sort((a, b) => a.nextDueDate.getTime() - b.nextDueDate.getTime());
  const reserved = new Map<string, { new: number; review: number }>();
  const fits = (p: UserProgress, isNew: boolean, budget = reserved) => deckAncestors(deckName(p)).every(deck => {
    const used = counts.get(deck) ?? { new: 0, review: 0 }, selected = budget.get(deck) ?? { new: 0, review: 0 };
    return used.review + selected.review + selected.new < p.scheduler.options.reviewsPerDay && (!isNew || used.new + selected.new < p.scheduler.options.newPerDay);
  });
  const reserve = (p: UserProgress, isNew: boolean, budget = reserved) => {
    for (const deck of deckAncestors(deckName(p))) {
      const prior = budget.get(deck) ?? { new: 0, review: 0 };
      budget.set(deck, { new: prior.new + (isNew ? 1 : 0), review: prior.review + (isNew ? 0 : 1) });
    }
  };
  const due = available.filter(p => !p.temporaryDueDate && p.scheduler.queue === "DAY" && p.nextDueDate <= now).sort((a, b) => a.nextDueDate.getTime() - b.nextDueDate.getTime());
  const selectedDue: UserProgress[] = [];
  for (const p of due) if (selectedDue.length + minute.length + temporary.length < dueLimit && fits(p, false)) { reserve(p, false); selectedDue.push(p); }
  const selectedNew: UserProgress[][] = [];
  let newCount = 0;
  for (const original of newCardGroups(progress, available)) {
    // Individual-card allowances can end after recognition. Its unseen reverse
    // stays new until another daily place is available; it can never come first.
    const group = allowPartialIntroduction && newLimit - newCount === 1 && original.length === 2 && original[0].card?.direction === "DE_ES" ? original.slice(0,1) : original;
    if (newCount + group.length > newLimit) continue;
    const budget = new Map(reserved);
    if (!group.every(p => { if (!fits(p, true, budget)) return false; reserve(p, true, budget); return true; })) continue;
    for (const p of group) reserve(p, true);
    selectedNew.push(group);
    newCount += group.length;
  }
  const options = available[0]?.scheduler.options;
  const reviews = selectedDue.filter(p => p.scheduler.phase === "REVIEW");
  const interday = selectedDue.filter(p => p.scheduler.phase !== "REVIEW");
  const orderedDue = options?.interdayMix === 1 ? [...reviews, ...interday] : options?.interdayMix === 2 ? [...interday, ...reviews] : mix(reviews, interday);
  const dueGroups = orderedDue.map(p => [p]);
  const result = (options?.newMix === 1 ? [...dueGroups, ...selectedNew] : options?.newMix === 2 ? [...selectedNew, ...dueGroups] : mix(dueGroups, selectedNew)).flat();
  const ready = [...temporary.slice(0, dueLimit), ...minute.slice(0, Math.max(0, dueLimit - temporary.length)), ...result];
  if (ready.length) return ready;
  // Learn ahead only after the ready review/new queues have been exhausted.
  return available.filter(p => p.scheduler.queue === "MINUTE" && p.nextDueDate.getTime() <= now.getTime() + p.scheduler.options.learnAheadSeconds * 1000)
    .sort((a, b) => a.nextDueDate.getTime() - b.nextDueDate.getTime()).slice(0, dueLimit);
}
