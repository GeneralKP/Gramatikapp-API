import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { connectDB, disconnectDB } from "../config/db.js";
import { Phrase } from "../models/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PhraseData {
  id?: string;
  german: string;
  spanish: string;
  words?: string[];
}

async function seed() {
  console.log("🌱 Starting database seed...");

  try {
    await connectDB();

    // Read phrases.json from the frontend
    const phrasesPath = resolve(
      __dirname,
      "../../german-gramatic-web/src/data/phrases.json",
    );
    console.log(`📂 Reading phrases from: ${phrasesPath}`);

    const rawData = readFileSync(phrasesPath, "utf-8");
    const phrases: PhraseData[] = JSON.parse(rawData);

    console.log(`📊 Found ${phrases.length} phrases to import`);

    // Check if phrases already exist
    const existingCount = await Phrase.countDocuments();
    if (existingCount > 0) {
      console.log(`⚠️  Database already has ${existingCount} phrases.`);
      console.log("   Use --force to overwrite existing data.");

      if (!process.argv.includes("--force")) {
        console.log("❌ Seed cancelled. Database unchanged.");
        await disconnectDB();
        return;
      }

      console.log("🗑️  Clearing existing phrases...");
      await Phrase.deleteMany({});
    }

    // Transform and insert phrases
    const phraseDocs = phrases.map((p) => ({
      german: p.german,
      spanish: p.spanish,
      words: p.words || p.german.split(/\s+/),
      tags: ["phrase"],
      createdAt: new Date(),
    }));

    // Insert in batches of 500
    const batchSize = 500;
    let inserted = 0;

    for (let i = 0; i < phraseDocs.length; i += batchSize) {
      const batch = phraseDocs.slice(i, i + batchSize);
      await Phrase.insertMany(batch);
      inserted += batch.length;
      console.log(`   Inserted ${inserted}/${phraseDocs.length} phrases...`);
    }

    console.log(`✅ Successfully seeded ${inserted} phrases!`);

    await disconnectDB();
  } catch (error) {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  }
}

seed();
