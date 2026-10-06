import { ObjectId } from "mongodb";
import { getDb, type Database } from "../../lib/database.js";
import type { User } from "../auth/auth.types.js";
import type { UserProgress, StudyCard } from "./progress.types.js";
import { loadDueStudyProgress, loadMoreStudyProgress } from "./progress.resolvers.js";
import { withScheduler } from "./reviews.js";
import { schedulerSeed, type DeckOptions } from "./scheduler.js";
import { studyMetadata, studyCatalog, STUDY_CONTENT_BATCH_SIZE } from "./studyLoading.js";
import type { Word } from "../words/words.types.js";
import type { Phrase } from "../phrases/phrases.types.js";
import { studyTextCatalog } from "./studyTextCatalog.js";

// Selection/state inputs only. Rich prompts, notes/examples and append-only
// failure/import history are fetched only for playable cards after selection.
export const COMPACT_STUDY_SELECTION = {
  _id: 1, userId: 1, itemId: 1, itemType: 1, relationId: 1,
  failureIndex: 1, isNew: 1, suspended: 1, supersededByAnki: 1, buriedUntil: 1,
  scheduler: 1, scheduleVersion: 1,
  "anki.type": 1, "anki.queue": 1, "anki.left": 1, "anki.reps": 1,
  "anki.did": 1, "anki.odid": 1, "anki.due": 1,
  ease: 1, interval: 1, repetitions: 1, totalReviews: 1, lapses: 1,
  nextDueDate: 1, temporaryDueDate: 1, lastReviewed: 1, createdAt: 1, updatedAt: 1,
  "card.sourceCardId": 1, "card.sourceNoteGuid": 1, "card.direction": 1, "card.deck": 1,
};

type State = Omit<UserProgress, "scheduler" | "card"> & { scheduler: Omit<NonNullable<UserProgress["scheduler"]>, "options">; fuzzSeed: string };
export interface CompactStudyShell {
  id: string;
  type: UserProgress["itemType"];
  german: string;
  spanish: string;
  contexts: string[];
  failureIndex: number;
  card: Pick<StudyCard, "sourceNoteGuid" | "direction"> | null;
  schedule: { version: number; profile: number; state: Partial<State> };
  extraPractice?: boolean;
}
export interface CompactStudyItem extends Omit<CompactStudyShell, "card"> {
  card: Pick<StudyCard, "sourceNoteGuid" | "direction" | "prompt" | "answer" | "acceptedAnswers" | "notes" | "examples"> | null;
  gramaticalCategories?: string[];
  forms?: Pick<NonNullable<Word["forms"]>, "past" | "perfect" | "imperativ"> & { article?: string };
  synonyms?: string[];
  wordNotes?: string;
  examples?: string[];
  spanishExamples?: string[];
}
export interface CompactStudyEnvelope {
  version: 1;
  profiles: DeckOptions[];
  items: CompactStudyItem[];
  manifest: CompactStudyShell[];
  remaining: number;
  complete: boolean;
}

function requestScope(user: User, input: any) {
  if (!user?._id) throw new Error("Unauthorized");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid study request");
  if (input.userId !== undefined && input.userId !== String(user._id)) throw new Error("Invalid study owner");
  if (input.itemType !== undefined && !["WORD", "PHRASE"].includes(input.itemType)) throw new Error("Invalid card type");
  if (input.context !== undefined && (typeof input.context !== "string" || input.context.length > 200)) throw new Error("Invalid study context");
  return { userId: String(user._id), itemType: input.itemType, context: input.context };
}
const bounded = (value: unknown, fallback: number, maximum: number, name: string) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${name}`);
  return Math.min(maximum, value as number);
};

interface LanguagePair { main: Word | Phrase; translated: Word | Phrase }
async function languagePairs(progress: UserProgress[], db: Database): Promise<Map<string, LanguagePair>> {
  const result = new Map<string, LanguagePair>();
  if (!progress.length) return result;
  const types = new Set(progress.map(p => p.itemType));
  const itemType = types.size === 1 ? [...types][0] : undefined;
  const [relations, text] = await Promise.all([studyCatalog({}, itemType, false), studyTextCatalog(itemType, db)]);
  for (const type of types) {
    const wanted = new Set(progress.filter(p => p.itemType === type).map(p => String(p.relationId || p.itemId)));
    const main = type === "WORD" ? text.wordsES : text.phrasesES, translated = type === "WORD" ? text.wordsDE : text.phrasesDE;
    const mainMap = new Map<string, Word | Phrase>(main.map(row => [String(row._id), row] as const));
    const translatedMap = new Map<string, Word | Phrase>(translated.map(row => [String(row._id), row] as const));
    for (const relation of type === "WORD" ? relations.words : relations.phrases) {
      if (!wanted.has(String(relation._id))) continue;
      const a = mainMap.get(String(relation.main)), b = translatedMap.get(String(relation.translated));
      // GraphQL's non-null endpoints make the whole relation null if either is
      // missing; explicit transport cards retain the same fallback behavior.
      if (a && b) result.set(`${type}:${relation._id}`, { main: a, translated: b });
    }
  }
  return result;
}

async function playableItems(progress: UserProgress[], pairs: Map<string, LanguagePair>, db: Database) {
  const ids = progress.map(p => p.itemId);
  const cardsRequest = ids.length ? db.progress.find({ userId: progress[0].userId, itemId: { $in: ids } })
    .project<{ itemId: ObjectId; card?: StudyCard }>({ _id: 0, itemId: 1, card: 1 }).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray() : Promise.resolve([]);
  const words = progress.filter(p => p.itemType === "WORD").map(p => ({ p, pair: pairs.get(`WORD:${p.relationId || p.itemId}`) })).filter(row => row.pair);
  const phrases = progress.filter(p => p.itemType === "PHRASE").map(p => pairs.get(`PHRASE:${p.relationId || p.itemId}`)).filter(Boolean);
  const germanIds = [...new Map(words.map(({ pair }) => [String(pair.translated._id), pair.translated._id])).values()];
  const legacyWords = words.filter(({ p }) => !p.card);
  const [cards, grammar, legacyMain, legacyTranslated, phraseMeta] = await Promise.all([
    cardsRequest,
    germanIds.length ? db.wordsDE.find({ _id: { $in: germanIds } }).project<Word>({ _id: 1, gramaticalCategories: 1, "forms.gender": 1, "forms.past": 1, "forms.perfect": 1, "forms.imperativ": 1 }).toArray() : [] as Word[],
    legacyWords.length ? db.wordsES.find({ _id: { $in: legacyWords.map(({ pair }) => pair.main._id) } }).project<Word>({ _id: 1, examples: 1 }).toArray() : [] as Word[],
    legacyWords.length ? db.wordsDE.find({ _id: { $in: legacyWords.map(({ pair }) => pair.translated._id) } }).project<Word>({ _id: 1, notes: 1, examples: 1 }).toArray() : [] as Word[],
    phrases.length ? db.phrasesDE.find({ _id: { $in: phrases.map(pair => pair.translated._id) } }).project<Phrase>({ _id: 1, synonyms: 1 }).toArray() : [] as Phrase[],
  ]);
  return { cards: new Map(cards.map(row => [String(row.itemId), row.card] as const)), grammar: new Map(grammar.map(row => [String(row._id), row] as const)),
    legacyMain: new Map(legacyMain.map(row => [String(row._id), row] as const)), legacyTranslated: new Map(legacyTranslated.map(row => [String(row._id), row] as const)),
    phraseMeta: new Map(phraseMeta.map(row => [String(row._id), row] as const)) };
}

async function envelope(progress: UserProgress[], cardLimit = progress.length, includeManifest = true): Promise<CompactStudyEnvelope> {
  const db = getDb(), profiles: DeckOptions[] = [], profileIndexes = new Map<string, number>();
  // End the starter after a whole NEW directional pair, rather than hiding its
  // immediately following production card behind the background request.
  if (cardLimit > 0 && cardLimit < progress.length) {
    const previous = progress[cardLimit - 1], following = progress[cardLimit];
    if (previous.scheduler.phase === "NEW" && following.scheduler.phase === "NEW" && previous.card?.direction === "DE_ES" && following.card?.direction === "ES_DE" && previous.card.sourceNoteGuid === following.card.sourceNoteGuid) cardLimit++;
  }
  const selected = progress.slice(0, cardLimit);
  const pairs = await languagePairs(progress, db);
  const playable = await playableItems(selected, pairs, db);
  const manifest: CompactStudyShell[] = progress.map(p => {
    const { options, ...scheduler } = p.scheduler;
    const key = JSON.stringify(Object.keys(options).sort().map(key => [key, options[key]]));
    let profile = profileIndexes.get(key);
    if (profile === undefined) { profile = profiles.length; profiles.push(options); profileIndexes.set(key, profile); }
    const pair = pairs.get(`${p.itemType}:${p.relationId || p.itemId}`);
    return {
      id: String(p.itemId), type: p.itemType, german: pair ? (p.itemType === "WORD" ? (pair.translated as Word).word : (pair.translated as Phrase).phrase) : "",
      spanish: pair ? (p.itemType === "WORD" ? (pair.main as Word).word : (pair.main as Phrase).phrase) : "", contexts: pair?.main.contexts ?? [], failureIndex: p.failureIndex ?? 0,
      card: p.card ? { sourceNoteGuid: p.card.sourceNoteGuid, direction: p.card.direction } : null,
      schedule: { version: p.scheduleVersion ?? 0, profile, state: {
        itemId: String(p.itemId) as any, itemType: p.itemType, ease: p.ease, interval: p.interval, repetitions: p.repetitions,
        nextDueDate: p.nextDueDate, temporaryDueDate: p.temporaryDueDate, lastReviewed: p.lastReviewed, createdAt: p.createdAt,
        scheduler, totalReviews: p.totalReviews ?? 0, lapses: p.lapses ?? 0, isNew: p.isNew, suspended: p.suspended, buriedUntil: p.buriedUntil,
        fuzzSeed: schedulerSeed(p).toString(),
      } },
      ...((p as any).extraPractice ? { extraPractice: true } : {}),
    };
  });
  const items: CompactStudyItem[] = manifest.slice(0, selected.length).map((shell, index) => {
    const p = selected[index], card = playable.cards.get(shell.id), pair = pairs.get(`${p.itemType}:${p.relationId || p.itemId}`);
    const grammar = pair && playable.grammar.get(String(pair.translated._id));
    return { ...shell, card: card ? { sourceNoteGuid: card.sourceNoteGuid, direction: card.direction, prompt: card.prompt, answer: card.answer, acceptedAnswers: card.acceptedAnswers, notes: card.notes, examples: card.examples } : null,
      ...(grammar ? { gramaticalCategories: grammar.gramaticalCategories ?? [], forms: grammar.forms ? { article: grammar.forms.gender, past: grammar.forms.past, perfect: grammar.forms.perfect, imperativ: grammar.forms.imperativ } : undefined } : {}),
      ...(pair && p.itemType === "PHRASE" ? { synonyms: playable.phraseMeta.get(String(pair.translated._id))?.synonyms ?? [] } : {}),
      ...(pair && p.itemType === "WORD" && !card ? { wordNotes: playable.legacyTranslated.get(String(pair.translated._id))?.notes,
        examples: playable.legacyTranslated.get(String(pair.translated._id))?.examples ?? [], spanishExamples: playable.legacyMain.get(String(pair.main._id))?.examples ?? [] } : {}),
    };
  });
  return { version: 1, profiles, items, manifest: includeManifest ? manifest : [], remaining: manifest.length - items.length, complete: manifest.length === items.length };
}

export async function loadCompactStudyQueue(user: User, input: any = {}): Promise<CompactStudyEnvelope> {
  const scope = requestScope(user, input);
  const cardLimit = bounded(input.cardLimit, Number.MAX_SAFE_INTEGER, 5000, "cardLimit");
  const progress = await loadDueStudyProgress({ ...scope, dueLimit: bounded(input.dueLimit, 5000, 5000, "dueLimit"), newLimit: bounded(input.newLimit, 20, 1000, "newLimit"), includeLearningAhead: true }, { user }, COMPACT_STUDY_SELECTION);
  return envelope(progress, cardLimit);
}
export async function loadCompactStudyMore(user: User, input: any = {}): Promise<CompactStudyEnvelope> {
  const scope = requestScope(user, input);
  const progress = await loadMoreStudyProgress({ ...scope, limit: bounded(input.limit, 20, 500, "limit") }, { user }, COMPACT_STUDY_SELECTION);
  return envelope(progress, progress.length, false);
}
export async function loadCompactStudyCards(user: User, input: any): Promise<CompactStudyEnvelope> {
  requestScope(user, input);
  if (!Array.isArray(input.itemIds) || input.itemIds.length > 5000 || input.itemIds.some(id => typeof id !== "string" || !ObjectId.isValid(id)) || new Set(input.itemIds).size !== input.itemIds.length) throw new Error("Invalid itemIds");
  const db = getDb(), ids = input.itemIds.map((id: string) => new ObjectId(id));
  const [stored, { profile }] = await Promise.all([
    ids.length ? db.progress.find({ userId: user._id, itemId: { $in: ids }, supersededByAnki: { $ne: true } }).project<UserProgress>(COMPACT_STUDY_SELECTION).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray() : [] as UserProgress[],
    studyMetadata({ user }, user._id),
  ]);
  const byId = new Map(stored.map(p => [String(p.itemId), p] as const));
  if (ids.some(id => !byId.has(String(id)))) throw new Error("Study card unavailable");
  const ordered = await Promise.all(ids.map(id => withScheduler(byId.get(String(id)), profile)));
  return envelope(ordered, ordered.length, false);
}
