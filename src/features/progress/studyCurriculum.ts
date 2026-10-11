import { CEFR_LEVELS, type CefrLevel } from '../levels/levels.js';
import { studyCatalog } from './studyLoading.js';
import { studyTextCatalog } from './studyTextCatalog.js';
import type { UserProgress } from './progress.types.js';
import type { Word, WordRelation } from '../words/words.types.js';
import type { Phrase, PhraseRelation } from '../phrases/phrases.types.js';

export interface CurriculumEntry {
  type: 'WORD' | 'PHRASE'; relation: WordRelation | PhraseRelation;
  level?: CefrLevel; rank: number;
}

/** One allocation budget shared by persisted retrieval and read-only counters.
 * Pending groups win ties within a level. Keep complete pairs for prerequisite
 * checks; the final queue selector can expose recognition at an odd allowance. */
export function planCurriculumIntroductions(groups: UserProgress[][], unseen: CurriculumEntry[], needed: number, allowPartial: boolean, rank: (p: UserProgress) => number) {
  const pending: UserProgress[] = [], entries: CurriculumEntry[] = [];
  let groupIndex = 0, entryIndex = 0, remaining = needed;
  while (remaining > 0 && (groupIndex < groups.length || entryIndex < unseen.length)) {
    const group = groups[groupIndex], entry = unseen[entryIndex];
    if (group && (!entry || rank(group[0]) <= entry.rank)) {
      groupIndex++;
      const cost = group.length === 1 && group[0].itemType === 'WORD' && !group[0].card ? 2 : group.length;
      if (cost > remaining && !allowPartial) continue;
      const selected = allowPartial && remaining === 1 && group.length === 2 && group[0].card?.direction === 'DE_ES' ? group.slice(0, 1) : group;
      if (selected.length > remaining) continue;
      pending.push(...group); remaining -= Math.min(cost, remaining);
    } else {
      entryIndex++;
      const cost = entry.type === 'WORD' ? 2 : 1;
      if (cost > remaining && !allowPartial) continue;
      entries.push(entry); remaining -= Math.min(cost, remaining);
    }
  }
  return { pending, entries };
}
interface Index { entries: CurriculumEntry[]; ranks: Map<string, number>; }
const generations = new WeakMap<object, { german: object; spanish: object; index: Index }>();
const mixedGenerations = new WeakMap<Index, WeakMap<Index, CurriculumEntry[]>>();
const compareEntries = (a: CurriculumEntry, b: CurriculumEntry) => a.rank - b.rank || String(a.relation._id).localeCompare(String(b.relation._id)) || a.type.localeCompare(b.type);
export function curriculumIndex(type: CurriculumEntry['type'], relations: (WordRelation | PhraseRelation)[], german: (Word | Phrase)[], spanish: (Word | Phrase)[]): Index {
  const cached = generations.get(relations);
  if (cached?.german === german && cached.spanish === spanish) return cached.index;
  const de = new Map(german.map(row => [String(row._id), row])), es = new Set(spanish.map(row => String(row._id)));
  const entries = relations.filter(row => de.has(String(row.translated)) && es.has(String(row.main))).map(relation => {
    const raw = de.get(String(relation.translated))!.cefrLevel;
    const rank = CEFR_LEVELS.indexOf(raw as CefrLevel);
    return { type, relation, level: rank < 0 ? undefined : raw, rank: rank < 0 ? CEFR_LEVELS.length : rank };
  }).sort(compareEntries);
  const result = { entries, ranks: new Map(entries.map(row => [String(row.relation._id), row.rank])) };
  generations.set(relations, { german, spanish, index: result });
  return result;
}

/** Immutable German-target curriculum; rebuilt only when shared catalog arrays
 * change. Owner progress is never cached. Unclassified cards follow C2.2. */
export async function studyCurriculum(context: object, itemType?: string) {
  const [catalog, text] = await Promise.all([studyCatalog(context, itemType, false), studyTextCatalog(itemType)]);
  const words = itemType !== 'PHRASE' ? curriculumIndex('WORD', catalog.words, text.wordsDE, text.wordsES) : undefined;
  const phrases = itemType !== 'WORD' ? curriculumIndex('PHRASE', catalog.phrases, text.phrasesDE, text.phrasesES) : undefined;
  let entries = words?.entries ?? phrases!.entries;
  if (words && phrases) {
    let mixed = mixedGenerations.get(words);
    if (!mixed) mixedGenerations.set(words, mixed = new WeakMap());
    entries = mixed.get(phrases)!;
    if (!entries) { entries = [...words.entries, ...phrases.entries].sort(compareEntries); mixed.set(phrases, entries); }
  }
  const rank = (p: UserProgress) => (p.itemType === 'WORD' ? words : phrases)?.ranks.get(String(p.relationId ?? p.itemId)) ?? CEFR_LEVELS.length;
  const has = (p: UserProgress) => (p.itemType === 'WORD' ? words : phrases)?.ranks.has(String(p.relationId ?? p.itemId)) ?? false;
  return { entries, rank, has, compare: (a: UserProgress, b: UserProgress) => rank(a) - rank(b) };
}
