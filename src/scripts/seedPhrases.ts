/**
 * Seed script to parse phrases.rtf and import into MongoDB Atlas
 * Database: gramatikapp
 * Collection: de-es
 *
 * Data Structure:
 * {
 *   german: string,      // German phrase
 *   spanish: string,     // Spanish translation
 *   words: string[],     // Individual words from German phrase
 *   tags: string[],      // Tags for categorization (default: ["phrase"])
 *   difficulty: string,  // Based on phrase length (basic/intermediate/advanced)
 *   createdAt: Date
 * }
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Build MongoDB Atlas connection string from env variables
const DB_USER = process.env.DB_USER || "";
const DB_USER_PASSWORD = process.env.DB_USER_PASSWORD || "";
const DB_CLUSTER = process.env.DB_CLUSTER || "";
const DB_NAME = "gramatikapp";
const COLLECTION_NAME = "de-es";

const MONGODB_URI = `mongodb+srv://${DB_USER}:${DB_USER_PASSWORD}@${DB_CLUSTER}.mongodb.net/${DB_NAME}?retryWrites=true&w=majority`;

// Phrase Schema
const phraseSchema = new mongoose.Schema(
  {
    german: {
      type: String,
      required: true,
      trim: true,
    },
    spanish: {
      type: String,
      required: true,
      trim: true,
    },
    words: {
      type: [String],
      default: [],
    },
    tags: {
      type: [String],
      default: ["phrase"],
    },
    difficulty: {
      type: String,
      enum: ["basic", "intermediate", "advanced"],
      default: "intermediate",
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: COLLECTION_NAME, // Use the specific collection name
  },
);

const Phrase = mongoose.model("Phrase", phraseSchema);

/**
 * Parse RTF content and extract phrase pairs
 */
function parseRTF(content: string): Array<{ german: string; spanish: string }> {
  const phrases: Array<{ german: string; spanish: string }> = [];

  // Remove RTF header and formatting codes
  // Extract lines that contain the pipe separator
  const lines = content.split(/\\+\n|\\\\|\n/);

  for (const line of lines) {
    // Skip lines that don't contain pipe separator or are RTF codes
    if (!line.includes("|") || line.startsWith("\\") || line.startsWith("{")) {
      continue;
    }

    // Clean RTF escape sequences
    let cleanLine = line
      .replace(/\\'e4/g, "ä") // ä
      .replace(/\\'f6/g, "ö") // ö
      .replace(/\\'fc/g, "ü") // ü
      .replace(/\\'df/g, "ß") // ß
      .replace(/\\'c4/g, "Ä") // Ä
      .replace(/\\'d6/g, "Ö") // Ö
      .replace(/\\'dc/g, "Ü") // Ü
      .replace(/\\'e1/g, "á") // á
      .replace(/\\'e9/g, "é") // é
      .replace(/\\'ed/g, "í") // í
      .replace(/\\'f3/g, "ó") // ó
      .replace(/\\'fa/g, "ú") // ú
      .replace(/\\'f1/g, "ñ") // ñ
      .replace(/\\'d1/g, "Ñ") // Ñ
      .replace(/\\'bf/g, "¿") // ¿
      .replace(/\\'a1/g, "¡") // ¡
      .replace(/\\f0\\fs24 \\cf0 /g, "")
      .replace(/\\[a-z]+[0-9]*\s*/g, "")
      .replace(/\{|\}/g, "")
      .trim();

    if (!cleanLine.includes("|")) continue;

    const parts = cleanLine.split("|");
    if (parts.length >= 2) {
      const german = parts[0].trim();
      const spanish = parts[1].trim();

      // Skip empty or header lines
      if (
        german &&
        spanish &&
        german !== "DEUTSCH" &&
        spanish !== "ESPAÑOL" &&
        german.length > 2
      ) {
        phrases.push({ german, spanish });
      }
    }
  }

  return phrases;
}

/**
 * Determine difficulty based on phrase length
 */
function getDifficulty(text: string): "basic" | "intermediate" | "advanced" {
  const wordCount = text.split(/\s+/).length;
  if (wordCount <= 5) return "basic";
  if (wordCount <= 12) return "intermediate";
  return "advanced";
}

/**
 * Extract individual words from German phrase
 */
function extractWords(german: string): string[] {
  return german
    .replace(/[.,!?;:'"]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

async function seedDatabase(): Promise<void> {
  console.log("🌱 Starting database seed...\n");

  // Read the RTF file (go up from scripts -> src -> german-gramatic-api -> German Gramatic)
  const rtfPath = resolve(
    __dirname,
    "../../../german-gramatic-web/phrases.rtf",
  );
  console.log(`📂 Reading phrases from: ${rtfPath}`);

  const rtfContent = readFileSync(rtfPath, "utf-8");

  // Parse phrases
  const phrases = parseRTF(rtfContent);
  console.log(`📝 Parsed ${phrases.length} phrase pairs\n`);

  if (phrases.length === 0) {
    console.log("❌ No phrases found. Exiting.");
    return;
  }

  // Show sample phrases
  console.log("📋 Sample phrases:");
  phrases.slice(0, 3).forEach((p, i) => {
    console.log(`   ${i + 1}. DE: ${p.german.substring(0, 50)}...`);
    console.log(`      ES: ${p.spanish.substring(0, 50)}...`);
  });
  console.log();

  // Connect to MongoDB Atlas
  console.log(`🔗 Connecting to MongoDB Atlas (${DB_NAME})...`);
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected successfully!\n");

  // Check if collection has data
  const existingCount = await Phrase.countDocuments();
  if (existingCount > 0) {
    console.log(`⚠️  Collection already has ${existingCount} documents.`);
    console.log("   Clearing collection before import...");
    await Phrase.deleteMany({});
    console.log("   ✅ Collection cleared.\n");
  }

  // Transform and insert phrases
  const documents = phrases.map((p) => ({
    german: p.german,
    spanish: p.spanish,
    words: extractWords(p.german),
    tags: ["phrase"],
    difficulty: getDifficulty(p.german),
    createdAt: new Date(),
  }));

  console.log("💾 Inserting phrases into database...");
  const result = await Phrase.insertMany(documents);
  console.log(`✅ Successfully inserted ${result.length} phrases!\n`);

  // Show statistics
  const basicCount = documents.filter((d) => d.difficulty === "basic").length;
  const intermediateCount = documents.filter(
    (d) => d.difficulty === "intermediate",
  ).length;
  const advancedCount = documents.filter(
    (d) => d.difficulty === "advanced",
  ).length;

  console.log("📊 Statistics:");
  console.log(`   Basic phrases:        ${basicCount}`);
  console.log(`   Intermediate phrases: ${intermediateCount}`);
  console.log(`   Advanced phrases:     ${advancedCount}`);
  console.log();

  // Disconnect
  await mongoose.disconnect();
  console.log("🏁 Database seeded successfully!");
}

// Run the seed
seedDatabase().catch((error) => {
  console.error("❌ Seed failed:", error);
  process.exit(1);
});
