import type { UserProgress } from "./progress.types.js";

const isWordCard = (p: UserProgress) => p.itemType === "WORD" && !!p.card && p.card.direction !== "CLOZE";
export const isNewCard = (p: UserProgress) => p.scheduler ? p.scheduler.phase === "NEW" : !!p.isNew;
const position = (p: UserProgress) => p.anki?.due ?? 0;

/** Keep introductions together, while using the original Anki position between words. */
export function newCardGroups(progress: UserProgress[], candidates: UserProgress[]): UserProgress[][] {
  const notes = new Map<string, UserProgress[]>();
  for (const p of progress) if (isWordCard(p)) {
    const key = p.card!.sourceNoteGuid;
    notes.set(key, [...(notes.get(key) ?? []), p]);
  }
  const eligible = new Set(candidates.filter(isNewCard).map(p => p.itemId.toString()));
  const handled = new Set<string>(), groups: UserProgress[][] = [];
  for (const p of candidates.filter(isNewCard)) {
    if (!isWordCard(p)) { groups.push([p]); continue; }
    const key = p.card!.sourceNoteGuid;
    if (handled.has(key)) continue;
    handled.add(key);
    const siblings = notes.get(key)!;
    const reading = siblings.find(s => s.card!.direction === "DE_ES");
    const typing = siblings.find(s => s.card!.direction === "ES_DE");
    if (reading && isNewCard(reading)) {
      // A buried/suspended recognition card must never expose its unseen reverse first.
      if (!eligible.has(reading.itemId.toString())) continue;
      if (typing && isNewCard(typing) && !eligible.has(typing.itemId.toString())) continue;
      groups.push([reading, ...(typing && eligible.has(typing.itemId.toString()) ? [typing] : [])]);
    } else if (typing && eligible.has(typing.itemId.toString())) groups.push([typing]);
    else if (reading && eligible.has(reading.itemId.toString())) groups.push([reading]);
  }
  return groups.sort((a, b) => Math.min(...a.map(position)) - Math.min(...b.map(position)) || a[0].itemId.toString().localeCompare(b[0].itemId.toString()));
}

export function isIntroductionFollowup(current: UserProgress, sibling: UserProgress) {
  return isWordCard(current) && isWordCard(sibling) && current.card!.sourceNoteGuid === sibling.card!.sourceNoteGuid
    && current.card!.direction === "DE_ES" && sibling.card!.direction === "ES_DE" && isNewCard(sibling);
}
