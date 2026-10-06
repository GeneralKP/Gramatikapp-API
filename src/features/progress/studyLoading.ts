import { ObjectId } from "mongodb";
import { getDb, type Database } from "../../lib/database.js";
import type { UserProgress } from "./progress.types.js";
import type { Word, WordRelation } from "../words/words.types.js";
import type { Phrase, PhraseRelation } from "../phrases/phrases.types.js";
import { DEFAULT_OPTIONS } from "./scheduler.js";
import type { User } from "../auth/auth.types.js";
import type { SchedulerProfile } from "./reviews.js";

const metadata = new WeakMap<object, Map<string, Promise<{ profile: SchedulerProfile | null; limit: number }>>>();
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
const snapshots = new WeakMap<object, Map<string, ReturnType<typeof loadSnapshot>>>();
async function loadSnapshot(context: object, userId: ObjectId) {
  const db = getDb();
  const [account, progress] = await Promise.all([
    studyMetadata(context, userId),
    db.progress.find({ userId }).project<UserProgress>({
      _id: 1, userId: 1, itemId: 1, itemType: 1, relationId: 1,
      isNew: 1, suspended: 1, supersededByAnki: 1, buriedUntil: 1,
      scheduler: 1, nextDueDate: 1, temporaryDueDate: 1, lastReviewed: 1,
      ease: 1, interval: 1, repetitions: 1, totalReviews: 1, lapses: 1, createdAt: 1, updatedAt: 1,
      anki: 1, "card.direction": 1, "card.sourceNoteGuid": 1,
      "card.sourceCardId": 1, "card.deck": 1,
    }).toArray(),
  ]);
  return { ...account, progress };
}

export function studySnapshot(context: object, userId: ObjectId) {
  let requests = snapshots.get(context);
  if (!requests) snapshots.set(context, requests = new Map());
  const key = String(userId);
  let snapshot = requests.get(key);
  if (!snapshot) requests.set(key, snapshot = loadSnapshot(context, userId));
  return snapshot;
}

const catalogs = new WeakMap<object, Map<string, Promise<unknown[]>>>();
interface StudyCatalog {
  words: WordRelation[];
  phrases: PhraseRelation[];
  wordMeta: Pick<Word, "_id" | "contexts" | "level">[];
  phraseMeta: Pick<Phrase, "_id" | "contexts" | "level">[];
}
export async function studyCatalog(context: object, itemType?: string, includeMetadata = true): Promise<StudyCatalog> {
  let parts = catalogs.get(context);
  if (!parts) catalogs.set(context, parts = new Map());
  const read = <T>(key: string, load: () => Promise<T[]>): Promise<T[]> => {
    let result = parts!.get(key);
    if (!result) parts!.set(key, result = load());
    return result as Promise<T[]>;
  };
  const db = getDb();
  const [words, phrases, wordMeta, phraseMeta] = await Promise.all([
    itemType !== "PHRASE" ? read("words", () => db.relationsWordsEsDe.find({}).project<WordRelation>({ _id: 1, main: 1, translated: 1 }).toArray()) : [] as WordRelation[],
    itemType !== "WORD" ? read("phrases", () => db.relationsPhrasesEsDe.find({}).project<PhraseRelation>({ _id: 1, main: 1, translated: 1 }).toArray()) : [] as PhraseRelation[],
    includeMetadata ? read("wordMeta", () => db.wordsES.find({}).project<Pick<Word, "_id" | "contexts" | "level">>({ _id: 1, contexts: 1, level: 1 }).toArray()) : [] as StudyCatalog["wordMeta"],
    includeMetadata ? read("phraseMeta", () => db.phrasesES.find({}).project<Pick<Phrase, "_id" | "contexts" | "level">>({ _id: 1, contexts: 1, level: 1 }).toArray()) : [] as StudyCatalog["phraseMeta"],
  ]);
  return { words, phrases, wordMeta, phraseMeta };
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
    const rows = await relations.find({ _id: { $in: ids.map(id => new ObjectId(id)) } }).toArray();
    const [main, translated] = await Promise.all([
      rows.length ? es.find({ _id: { $in: [...new Map(rows.map(row => [String(row.main), row.main] as const)).values()] } }).toArray() : [],
      rows.length ? de.find({ _id: { $in: [...new Map(rows.map(row => [String(row.translated), row.translated] as const)).values()] } }).toArray() : [],
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
