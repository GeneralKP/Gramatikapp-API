#!/usr/bin/env node
/**
 * Database Seeding Script
 *
 * Usage:
 *   npx tsx scripts/seedFromJson.ts <path-to-json-file>
 *
 * Example:
 *   npx tsx scripts/seedFromJson.ts ./data/chunk_01.json
 *
 * The JSON file must follow the SeedDataInput schema.
 * See SEED_PROMPT.md for the full schema details.
 */

import * as fs from "fs";
import * as path from "path";
import { connectDatabase } from "../src/lib/database.js";
import {
  processSeedData,
  SeedDataInput,
} from "../src/features/phrases/seedService.js";

// ─── ANSI color helpers ──────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  white: "\x1b[37m",
};

function printHeader(text: string) {
  console.log(`\n${C.bold}${C.cyan}${"═".repeat(60)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${text}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${"═".repeat(60)}${C.reset}\n`);
}

function printSection(title: string) {
  console.log(
    `${C.bold}${C.magenta}── ${title} ${"─".repeat(40 - title.length)}${C.reset}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      `${C.red}${C.bold}✖ Error:${C.reset} No JSON file path provided.\n`,
    );
    console.log(
      `${C.dim}Usage: npx tsx scripts/seedFromJson.ts <path-to-json>${C.reset}`,
    );
    console.log(
      `${C.dim}Example: npx tsx scripts/seedFromJson.ts ./data/chunk_01.json${C.reset}`,
    );
    process.exit(1);
  }

  const filePath = path.resolve(args[0]);

  if (!fs.existsSync(filePath)) {
    console.error(
      `${C.red}${C.bold}✖ Error:${C.reset} File not found: ${filePath}`,
    );
    process.exit(1);
  }

  printHeader("German Gramatic — Database Seeder");
  console.log(`${C.dim}File:${C.reset} ${filePath}`);
  console.log(`${C.dim}Time:${C.reset} ${new Date().toISOString()}\n`);

  // ── Parse JSON ──────────────────────────────────────────────────
  let data: SeedDataInput;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    data = JSON.parse(raw) as SeedDataInput;
  } catch (err: any) {
    console.error(
      `${C.red}${C.bold}✖ JSON parse error:${C.reset} ${err.message}`,
    );
    process.exit(1);
  }

  // Quick summary of the input
  console.log(`${C.bold}Input summary:${C.reset}`);
  console.log(`  Words DE:          ${(data.words_de || []).length}`);
  console.log(`  Words ES:          ${(data.words_es || []).length}`);
  console.log(`  Word relations:    ${(data.word_relations || []).length}`);
  console.log(`  Phrases DE:        ${(data.phrases_de || []).length}`);
  console.log(`  Phrases ES:        ${(data.phrases_es || []).length}`);
  console.log(`  Phrase relations:  ${(data.phrase_relations || []).length}`);
  console.log();

  // ── Connect & process ──────────────────────────────────────────
  const db = await connectDatabase();
  const result = await processSeedData(db, data);

  // ── Print results ──────────────────────────────────────────────
  printHeader("Seed Results");

  printSection("Words");
  console.log(`  ${C.green}✔ Created:${C.reset} ${result.wordsCreated}`);
  if (result.details.wordsCreatedList.length > 0) {
    result.details.wordsCreatedList.forEach((w) =>
      console.log(`    ${C.green}+${C.reset} ${w}`),
    );
  }
  console.log(`  ${C.yellow}⊘ Skipped:${C.reset} ${result.wordsSkipped}`);
  if (result.details.wordsSkippedList.length > 0) {
    result.details.wordsSkippedList.forEach((w) =>
      console.log(`    ${C.yellow}~${C.reset} ${w}`),
    );
  }

  console.log();
  printSection("Phrases");
  console.log(`  ${C.green}✔ Created:${C.reset} ${result.phrasesCreated}`);
  if (result.details.phrasesCreatedList.length > 0) {
    result.details.phrasesCreatedList.forEach((p) =>
      console.log(`    ${C.green}+${C.reset} ${p}`),
    );
  }
  console.log(`  ${C.yellow}⊘ Skipped:${C.reset} ${result.phrasesSkipped}`);
  if (result.details.phrasesSkippedList.length > 0) {
    result.details.phrasesSkippedList.forEach((p) =>
      console.log(`    ${C.yellow}~${C.reset} ${p}`),
    );
  }

  console.log();
  printSection("Relations");
  console.log(`  ${C.green}✔ Created:${C.reset} ${result.relationsCreated}`);

  console.log(`\n${C.bold}${C.green}${"═".repeat(60)}${C.reset}`);
  console.log(`${C.bold}${C.green}  ✓ Seeding complete!${C.reset}`);
  console.log(`${C.bold}${C.green}${"═".repeat(60)}${C.reset}\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error(`${C.red}${C.bold}✖ Fatal error:${C.reset}`, err);
  process.exit(1);
});
