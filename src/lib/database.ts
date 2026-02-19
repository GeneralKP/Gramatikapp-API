import * as dotenv from "dotenv";
dotenv.config();

import { MongoClient, Collection } from "mongodb";
import { User } from "../features/auth/auth.types.js";
import {
  Phrase,
  PhraseRelation,
  LegacyPhrase,
} from "../features/phrases/phrases.types.js";
import { Word, WordRelation } from "../features/words/words.types.js";
import { UserProgress } from "../features/progress/progress.types.js";

export interface Database {
  users: Collection<User>;
  phrases: Collection<LegacyPhrase>;
  progress: Collection<UserProgress>;

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

  return "mongodb://localhost:27017/german-gramatic";
};

let db: Database | null = null;

export const connectDatabase = async (): Promise<Database> => {
  if (db) return db;

  const client = await new MongoClient(getMongoURI(), {
    serverSelectionTimeoutMS: 10000,
  }).connect();
  const database = client.db("gramatikapp");

  db = {
    users: database.collection<User>("users"),
    phrases: database.collection<LegacyPhrase>("de-es"),
    progress: database.collection<UserProgress>("userprogresses"),

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
  await db.phrases.createIndex({ german: "text", spanish: "text" });
  await db.phrases.createIndex({ tags: 1 });

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

  console.log("✅ MongoDB connected (native driver)");
  return db;
};

export const getDb = (): Database => {
  if (!db) {
    throw new Error("Database not connected. Call connectDatabase() first.");
  }
  return db;
};
