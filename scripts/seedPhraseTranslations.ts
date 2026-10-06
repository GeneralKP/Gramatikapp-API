import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { MongoClient, ObjectId } from "mongodb";
import type { Database } from "../src/lib/database.js";
import { cleanTranslationWord, translationKey, dictionaryCaseMatches, saveReviewedEntry, validateReviewedEntry } from "../src/features/translations/translations.service.js";
import type { ReviewedTranslation, TranslationLanguage } from "../src/features/translations/translations.types.js";
import { CEFR_LEVELS } from "../src/features/levels/levels.js";

// This CLI intentionally has no provider calls. Every insertion requires reviewed JSON.
const directory = resolve("_seed/phrase-translations");
const mode = process.argv[2] || "audit";
if (!["audit", "check", "apply", "repair", "verify"].includes(mode)) throw new Error("Use audit, check, apply, repair or verify.");
const uri = process.env.MONGODB_URI || (process.env.DB_USER && process.env.DB_USER_PASSWORD && process.env.DB_CLUSTER
  ? `mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_USER_PASSWORD)}@${process.env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`
  : "mongodb://127.0.0.1:27017");
const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 }).connect();
const database = client.db("gramatikapp");
const db = Object.fromEntries(Object.entries({ wordsES: "WORDS_ES", wordsDE: "WORDS_DE", relationsWordsEsDe: "WORDS_ES_DE", phrasesES: "PHRASES_ES", phrasesDE: "PHRASES_DE", translationsEsDe: "TRANSLATIONS_ES_DE" }).map(([key, name]) => [key, database.collection(name)])) as unknown as Database;

async function audit() {
  const [de, es, relations, phrasesDE, phrasesES, translations] = await Promise.all([db.wordsDE.find({}).toArray(), db.wordsES.find({}).toArray(), db.relationsWordsEsDe.find({}).toArray(), db.phrasesDE.find({}).sort({ _id: 1 }).toArray(), db.phrasesES.find({}).sort({ _id: 1 }).toArray(), db.translationsEsDe.find({ status: "READY" }).toArray()]);
  const wordIndex: Record<string, any> = {};
  const phrases: { language: TranslationLanguage; id: string; phrase: string; tokens: { raw: string; key: string; position: number; status: string }[] }[] = [];
  for (const language of ["de", "es"] as const) {
    const words = language === "de" ? de : es, targets = language === "de" ? es : de;
    const targetById = new Map(targets.map(w => [String(w._id), w]));
    const byKey = new Map<string, typeof words>();
    for (const w of words) {
      const spelling = language === "de" ? w.word.replace(/^(der|die|das)\s+/i, "") : w.word;
      if (/\s/u.test(spelling)) continue;
      let key: string; try { key = translationKey(spelling); } catch { continue; }
      byKey.set(key, [...(byKey.get(key) ?? []), w]);
    }
    const field = language === "de" ? "translated" : "main", targetField = language === "de" ? "main" : "translated";
    const linked = new Map<string, string[]>();
    for (const relation of relations) {
      const target = targetById.get(String(relation[targetField]));
      if (target?.word?.trim()) linked.set(String(relation[field]), [...(linked.get(String(relation[field])) ?? []), target.word]);
    }
    const cached = new Map(translations.filter(t => t.sourceLanguage === language && t.translation?.trim()).map(t => [t.key, t]));
    for (const phrase of language === "de" ? phrasesDE : phrasesES) {
      const tokens: { raw: string; key: string; position: number; status: string }[] = [];
      for (const [position, raw] of phrase.phrase.split(/\s+/u).filter(Boolean).entries()) {
        // Punctuation-only tiles have no lexical translation.
        if (!/[\p{L}\p{N}]/u.test(raw)) continue;
        const word = cleanTranslationWord(raw), key = translationKey(word), indexKey = `${language}:${key}`;
        const candidates = (byKey.get(key) ?? []).filter(candidate => dictionaryCaseMatches(candidate, word, language));
        const dictionary = [...new Set(candidates.flatMap(w => linked.get(String(w._id)) ?? []))];
        const surface = cached.get(key);
        const status = dictionary.length ? "WORDS" : surface ? "TRANSLATIONS" : "MISSING";
        tokens.push({ raw, key, position, status });
        if (!wordIndex[indexKey]) {
          wordIndex[indexKey] = { language, key, word, catalogWordIds: candidates.map(w => String(w._id)), status, translation: dictionary.join(" / ") || surface?.translation || null, translationId: dictionary.length ? null : surface ? String(surface._id) : null, occurrences: [], contexts: [], examples: [] };
        }
        const indexed = wordIndex[indexKey];
        // Check every occurrence: a capitalized noun match cannot cover a
        // lowercase verb with the same normalized key later in the catalog.
        if (status === "MISSING" && indexed.status !== "MISSING") Object.assign(indexed, { word, status, translation: null, translationId: null });
        indexed.occurrences.push({ phraseId: String(phrase._id), position, raw });
        indexed.contexts = [...new Set([...indexed.contexts, ...(phrase.contexts ?? [])])];
        if (indexed.examples.length < 3 && !indexed.examples.includes(phrase.phrase)) indexed.examples.push(phrase.phrase);
      }
      phrases.push({ language, id: String(phrase._id), phrase: phrase.phrase, tokens });
    }
  }
  const summary = Object.fromEntries(["de", "es"].map(language => {
    const entries = Object.values(wordIndex).filter(w => w.language === language);
    return [language, { phrases: phrases.filter(p => p.language === language).length, uniqueWords: entries.length, words: entries.filter(w => w.status === "WORDS").length, translations: entries.filter(w => w.status === "TRANSLATIONS").length, missing: entries.filter(w => w.status === "MISSING").length }];
  }));
  const phraseFingerprint = createHash("sha256").update(JSON.stringify(phrases.map(p => [p.language, p.id, p.phrase]))).digest("hex");
  return { auditDate: new Date().toISOString(), database: "gramatikapp", scope: "Every primary PHRASES_DE and PHRASES_ES phrase; synonyms are alternate answers, not draggable word-bank sources.", phraseFingerprint, summary, phrases, wordIndex };
}

async function refreshManualLemmaReferences() {
  const [de, es, surfaces] = await Promise.all([db.wordsDE.find({}).toArray(), db.wordsES.find({}).toArray(), db.translationsEsDe.find({ status: "READY", origin: "MANUAL" }).toArray()]);
  const identity = (word: string, language: string) => (language === "de" ? word.replace(/^(der|die|das)\s+/i, "") : word).normalize("NFC").trim().toLowerCase();
  const maps = { de: new Map<string, typeof de>(), es: new Map<string, typeof es>() };
  for (const language of ["de", "es"] as const) for (const word of language === "de" ? de : es) {
    if (!word.gramaticalCategories?.some(category => category !== "UNKNOWN")) continue;
    const key = identity(word.word, language); maps[language].set(key, [...(maps[language].get(key) ?? []), word]);
  }
  const updates = [];
  for (const surface of surfaces) {
    const candidates = maps[surface.sourceLanguage].get(identity(surface.lemma ?? "", surface.sourceLanguage)) ?? [];
    const ids = candidates.filter(word => surface.category === "UNKNOWN" || word.gramaticalCategories?.includes(surface.category!)).map(word => word._id).sort((a, b) => String(a).localeCompare(String(b)));
    const previous = (surface.lemmaWordIds ?? []).map(String).sort();
    if (JSON.stringify(ids.map(String)) !== JSON.stringify(previous)) updates.push({ updateOne: { filter: { _id: surface._id, status: "READY", origin: "MANUAL" }, update: { $set: { lemmaWordIds: ids } } } });
  }
  if (updates.length) await db.translationsEsDe.bulkWrite(updates);
  return updates.length;
}

async function fillReviewedRelatedWordFields() {
  let completed = 0;
  for (const collection of [db.wordsDE, db.wordsES]) {
    const words = await collection.find({ "cefrClassification.model": "manual-phrase-review" }).toArray();
    const updates = words.flatMap(word => {
      const fill = Object.fromEntries(["synonyms", "antonyms", "homophones", "homonymous", "paronyms", "verbFamilies"].filter(key => word.relatedWords?.[key] === undefined).map(key => [`relatedWords.${key}`, []]));
      return Object.keys(fill).length ? [{ updateOne: { filter: { _id: word._id, "cefrClassification.model": "manual-phrase-review" }, update: { $set: fill } } }] : [];
    });
    if (updates.length) await collection.bulkWrite(updates);
    completed += updates.length;
  }
  return completed;
}

async function repairReviewedPhraseReferences() {
  const repairs = JSON.parse(readFileSync(resolve(directory, "phrase-reference-repairs.json"), "utf8"));
  const results: { phraseId: string; replacementWordId?: string; status: string }[] = [];
  for (const repair of repairs) {
    if (!["de", "es"].includes(repair.language) || !ObjectId.isValid(repair.phraseId) || !ObjectId.isValid(repair.missingWordId) || typeof repair.phrase !== "string" || typeof repair.replacementWord !== "string") throw new Error("Invalid reviewed phrase repair.");
    const language = repair.language as TranslationLanguage, words = language === "de" ? db.wordsDE : db.wordsES, phrases = language === "de" ? db.phrasesDE : db.phrasesES;
    const missingId = new ObjectId(repair.missingWordId), phraseId = new ObjectId(repair.phraseId);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const phrase = await phrases.findOne({ _id: phraseId, phrase: repair.phrase }, { session });
        if (!phrase) throw new Error("The phrase changed since the manual reference repair review.");
        if (!phrase.words.some(id => id.equals(missingId))) { results.push({ phraseId: repair.phraseId, status: "ALREADY_REPAIRED" }); return; }
        if (await words.findOne({ _id: missingId }, { session })) throw new Error("The supposedly dangling word now exists; do not replace it.");
        if (!phrase.phrase.split(/\s+/u).some(raw => translationKey(raw) === translationKey(repair.replacementWord))) throw new Error("The reviewed replacement does not occur in this phrase.");
        const candidates = await words.find({ word: repair.replacementWord, gramaticalCategories: repair.category }, { session }).sort({ _id: 1 }).toArray();
        const relationField = language === "de" ? "translated" : "main";
        const related = candidates.length ? await db.relationsWordsEsDe.findOne({ [relationField]: { $in: candidates.map(word => word._id) } }, { session }) : null;
        const replacement = related && candidates.find(word => word._id.equals(related[relationField]));
        if (!replacement) throw new Error("The repair requires a verified dictionary entry with a translation relation.");
        const seenReplacement = new Set<string>();
        const corrected = phrase.words.map(id => id.equals(missingId) ? replacement._id : id).filter(id => {
          if (!id.equals(replacement._id)) return true;
          if (seenReplacement.has(String(id))) return false; seenReplacement.add(String(id)); return true;
        });
        await phrases.updateOne({ _id: phraseId, words: phrase.words }, { $set: { words: corrected, updatedAt: new Date() } }, { session });
        results.push({ phraseId: repair.phraseId, replacementWordId: String(replacement._id), status: "REPAIRED" });
      });
    } finally { await session.endSession(); }
  }
  writeFileSync(resolve(directory, "reference-repair-result.json"), JSON.stringify({ repairedAt: new Date().toISOString(), results }, null, 2) + "\n");
  return results;
}

async function verifyStudyEntries() {
  const baseline = JSON.parse(readFileSync(resolve(directory, "baseline-catalog-identities.json"), "utf8"));
  const identity = (word: string, language: string, category: string) => `${language}:${category}:${(language === "de" ? word.replace(/^(der|die|das)\s+/i, "") : word).normalize("NFC").toLowerCase()}`;
  const reviewedSpellings = new Set<string>();
  for (const language of ["de", "es"] as const) {
    const manifest = JSON.parse(readFileSync(resolve(directory, `${language}-reviewed.json`), "utf8"));
    for (const raw of Array.isArray(manifest) ? manifest : manifest.entries) {
      const entry = validateReviewedEntry(raw, language);
      if (entry.kind !== "LEXEME") continue;
      reviewedSpellings.add(identity(entry.word, language, entry.category));
      reviewedSpellings.add(identity(entry.target!.word, language === "de" ? "es" : "de", entry.target!.category));
    }
  }
  const [de, es, relations, manualSurfaceTranslations] = await Promise.all([db.wordsDE.find({}).toArray(), db.wordsES.find({}).toArray(), db.relationsWordsEsDe.find({}).toArray(), db.translationsEsDe.countDocuments({ status: "READY", origin: "MANUAL" })]);
  const problems: string[] = [], entries: { language: string; id: string; word: string; category: string; change: string; cefrLevel: string }[] = [];
  for (const language of ["de", "es"] as const) for (const word of language === "de" ? de : es) {
    const previous = baseline.words[language][String(word._id)];
    const change = !previous ? "CREATED" : previous.every((category: string) => category === "UNKNOWN") && word.cefrClassification?.model === "manual-phrase-review" ? "REVIEWED_LEGACY_UNKNOWN" : null;
    if (!change) continue;
    const category = word.gramaticalCategories?.[0];
    const error = (reason: string) => problems.push(`${language}:${word._id}:${word.word}: ${reason}`);
    if (!category || word.gramaticalCategories.includes("UNKNOWN" as any)) error("study entries require a known category");
    if (!reviewedSpellings.has(identity(word.word, language, category))) error("study word is not a reviewed source or target dictionary form");
    if (!word.cefrLevel || !CEFR_LEVELS.includes(word.cefrLevel) || word.level !== word.cefrLevel.slice(0, 2)) error("invalid CEFR/level fields");
    if (!word.examples?.length || word.examples.some(example => typeof example !== "string" || !example.trim())) error("missing source-language example");
    // Catalog contexts are dynamic study-category strings, not just the GPT
    // prompt's LearningContext enum (see progress/categories.ts).
    if (!Array.isArray(word.contexts) || word.contexts.some(context => typeof context !== "string" || !/^[a-z0-9_]{1,100}$/.test(context))) error("invalid contexts");
    if (!word.notes?.trim() || !word.forms || !word.relatedWords || !word.createdAt || !word.updatedAt) error("incomplete word metadata");
    if (category === "NOUN" && (!word.forms?.gender || !word.forms.plural || language === "de" && !["der", "die", "das"].includes(word.forms.gender))) error("missing noun gender/plural");
    if (category === "VERB" && (!word.forms?.past || !word.forms.perfect || !word.forms.imperativ)) error("missing verb forms");
    const field = language === "de" ? "translated" : "main";
    if (!relations.some(relation => relation[field].equals(word._id))) error("study word has no bilingual relation");
    entries.push({ language, id: String(word._id), word: word.word, category, change, cefrLevel: word.cefrLevel ?? "" });
  }
  const result = { verifiedAt: new Date().toISOString(), baselineAuditDate: baseline.auditDate, providersUsed: 0, catalogCounts: { wordsDE: de.length, wordsES: es.length, wordRelations: relations.length, manualSurfaceTranslations }, addedWordRelations: relations.filter(relation => !baseline.wordRelationIds.includes(String(relation._id))).length, summary: Object.fromEntries(["de", "es"].map(language => [language, { created: entries.filter(entry => entry.language === language && entry.change === "CREATED").length, reviewedLegacyUnknown: entries.filter(entry => entry.language === language && entry.change === "REVIEWED_LEGACY_UNKNOWN").length }])), problems, entries };
  writeFileSync(resolve(directory, "study-entry-verification.json"), JSON.stringify(result, null, 2) + "\n");
  if (problems.length) throw new Error(`${problems.length} study-entry metadata problems; see study-entry-verification.json.`);
  console.log(`Study entries verified: ${JSON.stringify(result.summary)}; ${result.addedWordRelations} new bilingual relations.`);
}

try {
  mkdirSync(directory, { recursive: true });
  const current = await audit();
  console.log(JSON.stringify(current.summary));
  if (mode === "audit") {
    writeFileSync(resolve(directory, "audit-before.json"), JSON.stringify(current, null, 2) + "\n");
    console.log("Read-only phrase audit saved.");
  } else if (mode === "repair") {
    console.log(JSON.stringify(await repairReviewedPhraseReferences()));
    console.log(`Refreshed ${await refreshManualLemmaReferences()} lemma references after all dictionary entries were available.`);
    console.log(`Filled absent related-word fields on ${await fillReviewedRelatedWordFields()} manually reviewed dictionary entries.`);
  } else if (mode === "verify") {
    writeFileSync(resolve(directory, "audit-after.json"), JSON.stringify(current, null, 2) + "\n");
    if (Object.values(current.wordIndex).some(w => w.status === "MISSING")) throw new Error("Phrase coverage is incomplete; see audit-after.json.");
    const danglingRelations = await db.relationsWordsEsDe.aggregate([{ $lookup: { from: "WORDS_ES", localField: "main", foreignField: "_id", as: "es" } }, { $lookup: { from: "WORDS_DE", localField: "translated", foreignField: "_id", as: "de" } }, { $match: { $or: [{ es: { $size: 0 } }, { de: { $size: 0 } }] } }, { $count: "count" }]).toArray();
    if (danglingRelations.length) throw new Error("The word relations contain dangling references.");
    const [de, es, phraseDE, phraseES, surfaces] = await Promise.all([db.wordsDE.find({}).project({ _id: 1 }).toArray(), db.wordsES.find({}).project({ _id: 1 }).toArray(), db.phrasesDE.find({}).project({ _id: 1, words: 1 }).toArray(), db.phrasesES.find({}).project({ _id: 1, words: 1 }).toArray(), db.translationsEsDe.find({ status: "READY" }).toArray()]);
    const wordIds = { de: new Set(de.map(w => String(w._id))), es: new Set(es.map(w => String(w._id))) }, phraseIds = { de: new Set(phraseDE.map(p => String(p._id))), es: new Set(phraseES.map(p => String(p._id))) };
    for (const language of ["de", "es"] as const) for (const phrase of language === "de" ? phraseDE : phraseES) if (phrase.words?.some(id => !wordIds[language].has(String(id)))) throw new Error("A phrase contains a dangling word reference.");
    for (const surface of surfaces) {
      if (surface.lemmaWordIds?.some(id => !wordIds[surface.sourceLanguage].has(String(id))) || surface.phraseRefs?.some(ref => !phraseIds[ref.language].has(String(ref.phraseId)))) throw new Error("A surface translation contains a dangling lemma or phrase reference.");
    }
    await verifyStudyEntries();
    console.log("Every primary phrase word has a stored translation; word relation references verified.");
  } else {
    const before = JSON.parse(readFileSync(resolve(directory, "audit-before.json"), "utf8"));
    if (before.phraseFingerprint !== current.phraseFingerprint) throw new Error("The phrase catalog changed since the audit. Re-audit and manually review new words before applying.");
    const reviewed = new Map<string, ReviewedTranslation>();
    const problems: string[] = [];
    for (const language of ["de", "es"] as const) {
      const manifest = JSON.parse(readFileSync(resolve(directory, `${language}-reviewed.json`), "utf8"));
      for (const entry of (Array.isArray(manifest) ? manifest : manifest.entries)) {
        const key = `${language}:${entry.key}`;
        if (reviewed.has(key)) problems.push(`Duplicate reviewed key ${key}`);
        if (!current.wordIndex[key]) problems.push(`Reviewed word ${key} has no phrase occurrence`);
        try { reviewed.set(key, validateReviewedEntry(entry, language)); } catch (error) { problems.push(`${key}: ${(error as Error).message}`); }
      }
    }
    for (const [key, word] of Object.entries(current.wordIndex)) if (word.status === "MISSING" && !reviewed.has(key)) problems.push(`Missing manual review: ${key}`);
    if (problems.length) { writeFileSync(resolve(directory, "validation-errors.json"), JSON.stringify(problems, null, 2) + "\n"); throw new Error(`${problems.length} seed validation errors; see validation-errors.json. No seed writes performed.`); }
    if (existsSync(resolve(directory, "validation-errors.json"))) unlinkSync(resolve(directory, "validation-errors.json"));
    const pending = [...reviewed.entries()].filter(([key]) => current.wordIndex[key].status === "MISSING");
    const summary = { checkedAt: new Date().toISOString(), manualEntries: reviewed.size, pendingEntries: pending.length, lexemes: pending.filter(([, e]) => e.kind === "LEXEME").length, surfaces: pending.filter(([, e]) => e.kind === "SURFACE").length, providersUsed: 0 };
    writeFileSync(resolve(directory, "plan.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary));
    if (mode === "apply") {
      await db.translationsEsDe.createIndex({ sourceLanguage: 1, targetLanguage: 1, key: 1 }, { unique: true });
      await db.translationsEsDe.createIndex({ "phraseRefs.phraseId": 1 });
      let completed = 0;
      for (const [key, entry] of pending) {
        const indexed = current.wordIndex[key];
        const phraseIds = [...new Set<string>(indexed.occurrences.map(o => o.phraseId))];
        await saveReviewedEntry(db, client, entry, indexed.language, { origin: "MANUAL", examples: indexed.examples, contexts: indexed.contexts, phraseRefs: phraseIds.map(id => ({ language: indexed.language, phraseId: new ObjectId(id) })) });
        if (++completed % 100 === 0) console.log(`Saved ${completed}/${pending.length} reviewed words.`);
      }
      const lemmaReferencesRefreshed = await refreshManualLemmaReferences();
      const after = await audit();
      writeFileSync(resolve(directory, "audit-after.json"), JSON.stringify(after, null, 2) + "\n");
      writeFileSync(resolve(directory, "seed-result.json"), JSON.stringify({ ...summary, completedAt: new Date().toISOString(), completedEntries: completed, lemmaReferencesRefreshed, coverage: after.summary }, null, 2) + "\n");
      if (Object.values(after.wordIndex).some(w => w.status === "MISSING")) throw new Error("Seeding did not achieve complete coverage. Inspect audit-after.json.");
      console.log("Seed finished with complete phrase coverage. No external translation or AI provider used.");
    }
  }
} finally { await client.close(); }
