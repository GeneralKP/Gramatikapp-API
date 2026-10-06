import { ObjectId } from "mongodb";
import { getDb, type Database } from "../../lib/database.js";
import type { UserProgress } from "./progress.types.js";
import type { Word, WordRelation } from "../words/words.types.js";
import type { Phrase, PhraseRelation } from "../phrases/phrases.types.js";
import { DEFAULT_OPTIONS, studyDay } from "./scheduler.js";
import type { User } from "../auth/auth.types.js";
import { dailyCounts, type SchedulerProfile } from "./reviews.js";
import { catalogSummaryCache, type CatalogPart } from "./catalogSummaryCache.js";
import { studySpanishWords, studySpanishPhrases, studyTextCatalog } from "./studyTextCatalog.js";

// These reads already consume every result; larger batches remove the default
// 101-document first-batch round trip without imposing a result limit.
export const STUDY_CONTENT_BATCH_SIZE = 1000;
export const STUDY_SUMMARY_BATCH_SIZE = 5000;

const metadata = new WeakMap<object, Map<string, Promise<{ profile: SchedulerProfile | null; limit: number }>>>();
/** Reuse one fresh HTTP profile read only after its account has authenticated. */
export function seedStudyMetadata(context: { user: User }, userId: ObjectId, profileRequest: Promise<SchedulerProfile | null>) {
  if (!context.user._id.equals(userId)) throw new Error("Invalid study owner");
  let requests = metadata.get(context);
  if (!requests) metadata.set(context, requests = new Map());
  const key = String(userId);
  if (requests.has(key)) return;
  const result = profileRequest.then(profile => ({ profile, limit: context.user.settings?.dailyNewCards ?? profile?.defaultOptions.newPerDay ?? DEFAULT_OPTIONS.newPerDay }));
  // Validation or authentication can end the request before metadata is used.
  // Observing rejection here preserves its later failure without an orphan.
  void result.catch(() => undefined);
  requests.set(key, result);
}
export function studyMetadata(context: object, userId: ObjectId, knownUser?: Pick<User, "settings">) {
  let requests = metadata.get(context);
  if (!requests) metadata.set(context, requests = new Map());
  const key = String(userId);
  let result = requests.get(key);
  if (!result) {
    const db = getDb();
    const authenticated = (context as { user?: User }).user;
    const user = knownUser ?? (authenticated && String(authenticated._id) === key ? authenticated : undefined);
    result = Promise.all([
      db.schedulerProfiles.findOne({ _id: userId }),
      user ?? db.users.findOne({ _id: userId }, { projection: { "settings.dailyNewCards": 1 } }),
    ]).then(([profile, account]) => ({ profile, limit: account?.settings?.dailyNewCards ?? profile?.defaultOptions.newPerDay ?? DEFAULT_OPTIONS.newPerDay }));
    requests.set(key, result);
  }
  return result;
}

// Share only within one GraphQL request. Never cache account state across requests.
const snapshots = new WeakMap<object, Map<string, ReturnType<typeof loadCountSnapshot>>>();
async function loadCountSnapshot(context: object, userId: ObjectId, now: Date, itemType?: UserProgress["itemType"]) {
  const db = getDb();
  const [account, progress] = await Promise.all([
    studyMetadata(context, userId),
    db.progress.find({ userId, ...(itemType ? { itemType } : {}), $or: [
      { nextDueDate: { $lte: now } }, { temporaryDueDate: { $lte: now } },
      { "scheduler.phase": { $in: ["NEW", "LEARNING", "RELEARNING"] } },
      { scheduler: null },
    ] }).project<UserProgress>({
      _id: 1, userId: 1, itemId: 1, itemType: 1, relationId: 1,
      isNew: 1, suspended: 1, supersededByAnki: 1, buriedUntil: 1,
      // Only counter/selection inputs, never a serialized or persisted scheduler.
      "scheduler.phase": 1, "scheduler.queue": 1, "scheduler.timeZone": 1, "scheduler.rollover": 1,
      "scheduler.options.newPerDay": 1, "scheduler.options.reviewsPerDay": 1,
      "scheduler.options.learnAheadSeconds": 1, "scheduler.options.newMix": 1, "scheduler.options.interdayMix": 1,
      "scheduler.options.initialEase": 1, "scheduler.options.learningSteps": 1, "scheduler.options.relearningSteps": 1,
      nextDueDate: 1, temporaryDueDate: 1, lastReviewed: 1,
      ease: 1, interval: 1, repetitions: 1, totalReviews: 1, lapses: 1, createdAt: 1, updatedAt: 1,
      "anki.type": 1, "anki.queue": 1, "anki.left": 1, "anki.reps": 1,
      "anki.did": 1, "anki.odid": 1, "anki.due": 1,
      "card.direction": 1, "card.sourceNoteGuid": 1,
      "card.sourceCardId": 1, "card.deck": 1,
    }).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray(),
  ]);
  return { ...account, progress };
}

export function studyCountSnapshot(context: object, userId: ObjectId, now: Date, itemType?: UserProgress["itemType"]) {
  let requests = snapshots.get(context);
  if (!requests) snapshots.set(context, requests = new Map());
  const key = `${userId}:${itemType ?? "ALL"}`;
  let snapshot = requests.get(key);
  if (!snapshot) requests.set(key, snapshot = loadCountSnapshot(context, userId, now, itemType));
  return snapshot;
}

type StudyIdentity = Pick<UserProgress, "itemId" | "relationId" | "itemType" | "repetitions">;
const identities = new WeakMap<object, Map<string, Promise<StudyIdentity[]>>>();
export function studyIdentities(context: object, userId: ObjectId, phraseRelationIds?: ObjectId[]) {
  let requests = identities.get(context);
  if (!requests) identities.set(context, requests = new Map());
  const key = `${userId}:${phraseRelationIds ? "PHRASE_CATALOG" : "ALL"}`;
  let result = requests.get(key);
  // A phrase counter only needs identities which can match its catalog. Keep
  // cross-type matches and null/missing relationId fallbacks exactly as before.
  const scope = phraseRelationIds ? { $or: [
    { relationId: { $in: phraseRelationIds } },
    { relationId: null, itemId: { $in: phraseRelationIds } },
  ] } : {};
  if (!result) requests.set(key, result = getDb().progress.find({ userId, ...scope })
    .project<StudyIdentity>({ _id: 0, itemId: 1, relationId: 1, itemType: 1, repetitions: 1 })
    .batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray());
  return result;
}

const counts = new WeakMap<object, Map<string, ReturnType<typeof dailyCounts>>>();
export async function studyDailyCounts(context: object, userId: ObjectId, now: Date) {
  const { profile } = await studyMetadata(context, userId);
  const day = studyDay(now, profile?.timeZone ?? "Europe/Berlin", profile?.rollover ?? 4);
  let requests = counts.get(context);
  if (!requests) counts.set(context, requests = new Map());
  const key = `${userId}:${day}`;
  let result = requests.get(key);
  if (!result) requests.set(key, result = dailyCounts(userId, day, profile));
  return result;
}

const catalogs = new WeakMap<object, Map<string, Promise<unknown[]>>>();
interface StudyCatalog {
  words: WordRelation[];
  phrases: PhraseRelation[];
  wordMeta: Pick<Word, "_id" | "contexts" | "level">[];
  phraseMeta: Pick<Phrase, "_id" | "contexts" | "level">[];
}
export async function studyCatalog(context: object, itemType?: string, includeMetadata = true, refresh = false): Promise<StudyCatalog> {
  let parts = catalogs.get(context);
  if (!parts) catalogs.set(context, parts = new Map());
  const read = <T>(key: string, load: () => Promise<T[]>): Promise<T[]> => {
    let result = parts!.get(key);
    if (!result) parts!.set(key, result = load());
    return result as Promise<T[]>;
  };
  const db = getDb();
  const shared = <T>(part: CatalogPart, load: () => Promise<T[]>) => catalogSummaryCache[refresh ? "refresh" : "read"](db, part, load);
  const [words, phrases, wordMeta, phraseMeta] = await Promise.all([
    itemType !== "PHRASE" ? read("words", () => shared("words", () => db.relationsWordsEsDe.find({}).project<WordRelation>({ _id: 1, main: 1, translated: 1 }).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray())) : [] as WordRelation[],
    itemType !== "WORD" ? read("phrases", () => shared("phrases", () => db.relationsPhrasesEsDe.find({}).project<PhraseRelation>({ _id: 1, main: 1, translated: 1 }).batchSize(STUDY_SUMMARY_BATCH_SIZE).toArray())) : [] as PhraseRelation[],
    includeMetadata ? read("wordMeta", () => studySpanishWords(db, refresh)) : [] as StudyCatalog["wordMeta"],
    includeMetadata ? read("phraseMeta", () => studySpanishPhrases(db, refresh)) : [] as StudyCatalog["phraseMeta"],
  ]);
  return { words, phrases, wordMeta, phraseMeta };
}

/** Prepare immutable summaries before accepting the first browser request. */
export async function warmStudyCatalog() { await Promise.all([studyCatalog({}), studyTextCatalog()]); }

export const CATALOG_SUMMARY_REFRESH_MS = 15_000;
let catalogRefreshTimer: ReturnType<typeof setInterval> | undefined;
async function refreshStudyCatalog() {
  await Promise.all([studyCatalog({}, undefined, true, true), studyTextCatalog(undefined, getDb(), true)]);
}
export function startStudyCatalogRefresh() {
  if (catalogRefreshTimer) return;
  catalogRefreshTimer = setInterval(() => {
    void refreshStudyCatalog().catch(() => {
      console.warn("Catalog summary refresh failed; expired summaries will retry on demand.");
    });
  }, CATALOG_SUMMARY_REFRESH_MS);
  catalogRefreshTimer.unref();
}
export function stopStudyCatalogRefresh() {
  if (catalogRefreshTimer) clearInterval(catalogRefreshTimer);
  catalogRefreshTimer = undefined;
}

/** Unique-key upserts are idempotent; a concurrent duplicate is re-read by the caller. */
export async function insertNewProgress(docs: UserProgress[], db: Database = getDb()) {
  if (!docs.length) return;
  try {
    await db.progress.bulkWrite(docs.map(doc => ({ updateOne: {
      filter: { userId: doc.userId, itemId: doc.itemId, itemType: doc.itemType },
      update: { $setOnInsert: doc }, upsert: true,
    } })), { ordered: false });
  } catch (error: any) {
    if (error.code !== 11000 || error.writeErrors?.some((entry: any) => entry.code !== 11000)
      || error.writeConcernErrors?.length || error.result?.getWriteConcernError?.()) throw error;
  }
}

/** Load the selected queue's shared catalog content in bulk, including missing links. */
export async function loadStudyRelations<T extends { itemId: string; relationId?: string; itemType: string }>(items: T[], db: Database = getDb()) {
  const load = async (type: string, relations: Database["relationsWordsEsDe"] | Database["relationsPhrasesEsDe"], es: Database["wordsES"] | Database["phrasesES"], de: Database["wordsDE"] | Database["phrasesDE"]) => {
    const ids = [...new Set(items.filter(item => item.itemType === type).map(item => item.relationId || item.itemId))];
    if (!ids.length) return new Map();
    const rows = await relations.find({ _id: { $in: ids.map(id => new ObjectId(id)) } }).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray();
    const [main, translated] = await Promise.all([
      rows.length ? es.find({ _id: { $in: [...new Map(rows.map(row => [String(row.main), row.main] as const)).values()] } }).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray() : [],
      rows.length ? de.find({ _id: { $in: [...new Map(rows.map(row => [String(row.translated), row.translated] as const)).values()] } }).batchSize(STUDY_CONTENT_BATCH_SIZE).toArray() : [],
    ]);
    const mainMap = new Map(main.map(row => [String(row._id), row] as const)), translatedMap = new Map(translated.map(row => [String(row._id), row] as const));
    return new Map(rows.map(row => [String(row._id), {
      ...row, id: String(row._id), createdAt: row.createdAt?.toISOString(),
      mainDoc: mainMap.get(String(row.main)) ?? null, translatedDoc: translatedMap.get(String(row.translated)) ?? null,
    }]));
  };
  const [words, phrases] = await Promise.all([
    load("WORD", db.relationsWordsEsDe, db.wordsES, db.wordsDE),
    load("PHRASE", db.relationsPhrasesEsDe, db.phrasesES, db.phrasesDE),
  ]);
  return items.map(item => ({ ...item,
    loadedWordRelation: item.itemType === "WORD" ? words.get(item.relationId || item.itemId) ?? null : null,
    loadedPhraseRelation: item.itemType === "PHRASE" ? phrases.get(item.relationId || item.itemId) ?? null : null,
  }));
}
