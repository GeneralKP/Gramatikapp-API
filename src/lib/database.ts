import * as dotenv from "dotenv";
dotenv.config();

import { MongoClient, Collection } from "mongodb";
import { User } from "../features/auth/auth.types.js";
import { Phrase, PhraseRelation } from "../features/phrases/phrases.types.js";
import { Word, WordRelation } from "../features/words/words.types.js";
import { UserProgress } from "../features/progress/progress.types.js";
import { ReviewEvent, SchedulerProfile } from "../features/progress/reviews.js";
import type { ReadingLesson, TranslationAttempt } from "../features/reading/reading.types.js";
import type { WritingAttempt, WritingExercise, WritingHint } from "../features/writing/writing.types.js";

export interface Database {
  users: Collection<User>;
  progress: Collection<UserProgress>;
  reviewEvents: Collection<ReviewEvent>;
  schedulerProfiles: Collection<SchedulerProfile>;
  readingLessons: Collection<ReadingLesson>;
  translationAttempts: Collection<TranslationAttempt>;
  writingExercises: Collection<WritingExercise>;
  writingAttempts: Collection<WritingAttempt>;
  writingHints: Collection<WritingHint>;

  // New collections
  wordsES: Collection<Word>;
  wordsDE: Collection<Word>;
  phrasesES: Collection<Phrase>;
  phrasesDE: Collection<Phrase>;
  relationsWordsEsDe: Collection<WordRelation>;
  relationsPhrasesEsDe: Collection<PhraseRelation>;
}

const getMongoURI = (): string => {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const { DB_USER, DB_USER_PASSWORD, DB_CLUSTER } = process.env;
  if (DB_USER && DB_USER_PASSWORD && DB_CLUSTER) {
    return `mongodb+srv://${DB_USER}:${DB_USER_PASSWORD}@${DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
  }

  if (process.env.NODE_ENV === "production") throw new Error("Configure MONGODB_URI or the database environment variables in production");
  return "mongodb://localhost:27017/german-gramatic";
};

let db: Database | null = null;
let databaseClient: MongoClient | null = null;

export const connectDatabase = async (): Promise<Database> => {
  if (db) return db;

  const client = await new MongoClient(getMongoURI(), {
    serverSelectionTimeoutMS: 10000,
  }).connect();
  const database = client.db("gramatikapp");
  databaseClient = client;

  db = {
    users: database.collection<User>("users"),
    progress: database.collection<UserProgress>("userprogresses"),
    reviewEvents: database.collection<ReviewEvent>("reviewevents"),
    schedulerProfiles: database.collection<SchedulerProfile>("schedulerprofiles"),
    readingLessons: database.collection<ReadingLesson>("readinglessons"),
    translationAttempts: database.collection<TranslationAttempt>("translationattempts"),
    writingExercises: database.collection<WritingExercise>("writingexercises"),
    writingAttempts: database.collection<WritingAttempt>("writingattempts"),
    writingHints: database.collection<WritingHint>("writinghints"),

    // New collections
    wordsES: database.collection<Word>("WORDS_ES"),
    wordsDE: database.collection<Word>("WORDS_DE"),
    phrasesES: database.collection<Phrase>("PHRASES_ES"),
    phrasesDE: database.collection<Phrase>("PHRASES_DE"),
    relationsWordsEsDe: database.collection<WordRelation>("WORDS_ES_DE"),
    relationsPhrasesEsDe: database.collection<PhraseRelation>("PHRASES_ES_DE"),
  };

  // Create indexes
  await db.users.createIndex({ email: 1 }, { unique: true });

  try {
    await db.progress.dropIndex("userId_1_phraseId_1");
  } catch (e) {
    // Ignore if not exists
  }

  await db.progress.createIndex(
    { userId: 1, itemId: 1, itemType: 1 },
    { unique: true },
  );
  await db.progress.createIndex({ userId: 1, nextDueDate: 1 });
  await db.progress.createIndex({ userId: 1, itemType: 1, failureIndex: -1 });
  await db.progress.createIndex({ userId: 1, relationId: 1 });
  await db.reviewEvents.createIndex({ userId: 1, reviewId: 1 }, { unique: true });
  await db.reviewEvents.createIndex({ userId: 1, day: 1, reversedAt: 1, deck: 1 });
  await db.reviewEvents.createIndex({ userId: 1, itemId: 1, reviewedAt: -1 });
  await db.reviewEvents.createIndex({ userId: 1, reviewedAt: -1, _id: -1 });
  await db.readingLessons.createIndex({ userId: 1, sessionId: 1 }, { unique: true });
  await db.translationAttempts.createIndex({ userId: 1, requestId: 1 }, { unique: true });
  await db.translationAttempts.createIndex({ userId: 1, lessonId: 1, createdAt: -1 });
  await db.writingExercises.createIndex({ userId: 1, requestId: 1 }, { unique: true });
  await db.writingExercises.createIndex({ userId: 1, createdAt: -1 });
  await db.writingAttempts.createIndex({ userId: 1, requestId: 1 }, { unique: true });
  await db.writingAttempts.createIndex({ userId: 1, exerciseId: 1, createdAt: -1 });
  await db.writingHints.createIndex({ userId: 1, exerciseId: 1, word: 1 }, { unique: true });

  console.log("✅ MongoDB connected (native driver)");
  return db;
};

export const getDb = (): Database => {
  if (!db) {
    throw new Error("Database not connected. Call connectDatabase() first.");
  }
  return db;
};
export const getDatabaseClient = (): MongoClient => {
  if (!databaseClient) throw new Error("Database not connected");
  return databaseClient;
};

export const closeDatabase = async () => {
  await databaseClient?.close();
  databaseClient = null;
  db = null;
};
