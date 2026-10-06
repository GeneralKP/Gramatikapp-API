import { createHash, randomUUID } from "node:crypto";
import { ObjectId, type ClientSession, type MongoClient } from "mongodb";
import { getDb, getDatabaseClient, type Database } from "../../lib/database.js";
import { CEFR_LEVELS } from "../levels/levels.js";
import { GrammaticalCategory, LearningContext, type Word } from "../words/words.types.js";
import { generateTranslation } from "./translations.providers.js";
import { READING_MODEL } from "../reading/prompts.js";
import { invalidateStudyCatalog } from "../progress/catalogSummaryCache.js";
import type { PhraseReference, ReviewedTranslation, TranslationLanguage } from "./translations.types.js";

const LEASE_MS = 5 * 60_000;
const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function cleanTranslationWord(value: unknown): string {
  if (typeof value !== "string" || value.length > 150) throw new Error("Provide a word of up to 150 characters.");
  const word = value.normalize("NFC").trim().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N}'’\-]*$/u.test(word)) throw new Error("Provide one word, without spaces or standalone punctuation.");
  return word;
}
export const translationKey = (word: string) => cleanTranslationWord(word).toLocaleLowerCase();
function languagePair(source: unknown, target: unknown): [TranslationLanguage, TranslationLanguage] {
  if (!((source === "de" && target === "es") || (source === "es" && target === "de"))) throw new Error("Supported language pairs are de → es and es → de.");
  return [source, target];
}
const stableId = (value: string) => new ObjectId(createHash("sha256").update(value).digest("hex").slice(0, 24));
const isDictionaryVerb = (word: string, language: TranslationLanguage) => {
  const tokens = word.trim().split(/\s+/u);
  const heads = language === "de" ? [tokens[0], tokens[0] === "sich" ? tokens[1] : tokens.at(-1)] : [tokens[0]];
  return heads.some(head => (language === "de" ? /^(?:sein|tun)$|(?:en|eln|ern)$/i : /(?:ar|er|ir)(?:se)?$/i).test(head ?? ""));
};
const wordsFor = (db: Database, language: TranslationLanguage) => language === "de" ? db.wordsDE : db.wordsES;
const knownCategories = (word: Word): GrammaticalCategory[] => word.gramaticalCategories?.filter(category => category !== GrammaticalCategory.UNKNOWN) ?? [];

// German noun capitalization distinguishes meanings such as Verdienst/verdienst.
// Sentence-initial capitalization may still match verbs and function words.
export function dictionaryCaseMatches(candidate: Word, word: string, language: TranslationLanguage): boolean {
  if (language !== "de") return true;
  const categories = knownCategories(candidate);
  const spelling = candidate.word.replace(/^(der|die|das)\s+/i, "");
  return !(categories.length === 1 && categories[0] === GrammaticalCategory.NOUN && /^\p{Lu}/u.test(spelling) && /^\p{Ll}/u.test(word));
}

// Exact dictionary spelling, plus the article used by existing German noun entries.
// No stemming: a plural or conjugation must not silently become a lemma lookup.
async function exactWords(db: Database, word: string, language: TranslationLanguage, session?: ClientSession) {
  const bare = language === "de" ? word.replace(/^(der|die|das)\s+/i, "") : word;
  const pattern = language === "de" ? `^(?:(?:der|die|das)\\s+)?${escaped(bare)}$` : `^${escaped(word)}$`;
  return wordsFor(db, language).find({ word: { $regex: pattern, $options: "i" } }, { session }).toArray();
}
export async function lookupCatalogTranslation(db: Database, rawWord: string, sourceLanguage: TranslationLanguage) {
  const word = cleanTranslationWord(rawWord), targetLanguage: TranslationLanguage = sourceLanguage === "de" ? "es" : "de";
  const sources = (await exactWords(db, word, sourceLanguage)).filter(candidate => dictionaryCaseMatches(candidate, word, sourceLanguage));
  const field = sourceLanguage === "de" ? "translated" : "main", targetField = sourceLanguage === "de" ? "main" : "translated";
  const relations = sources.length ? await db.relationsWordsEsDe.find({ [field]: { $in: sources.map(w => w._id) } }).sort({ _id: 1 }).toArray() : [];
  const targets = relations.length ? await wordsFor(db, targetLanguage).find({ _id: { $in: relations.map(r => r[targetField]) } }).toArray() : [];
  const translations = [...new Set(targets.map(w => w.word).filter(w => typeof w === "string" && w.trim()))];
  return translations.length ? { word, translation: translations.join(" / "), source: "WORDS" as const, sourceLanguage, targetLanguage } : null;
}

export function validateReviewedEntry(value: any, language: TranslationLanguage): ReviewedTranslation {
  if (!value || !["LEXEME", "SURFACE"].includes(value.kind) || typeof value.word !== "string" || value.key !== translationKey(value.word)) throw new Error("Invalid reviewed word or key.");
  if (value.word !== cleanTranslationWord(value.word)) throw new Error("Reviewed source spelling must be clean NFC text without edge punctuation.");
  for (const field of ["translation", "lemma", "form"]) if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 1500) throw new Error(`Missing reviewed ${field}.`);
  if (!Object.values(GrammaticalCategory).includes(value.category) || !CEFR_LEVELS.includes(value.cefrLevel)) throw new Error("Invalid grammatical category or CEFR estimate.");
  const forms = (entry: any, lang: TranslationLanguage) => {
    if (entry.forms !== undefined && (!entry.forms || typeof entry.forms !== "object" || Array.isArray(entry.forms))) throw new Error("Invalid word forms.");
    const allowed = ["gender", "plural", "past", "perfect", "imperativ", "irregularConjugations", "gramaticalCase"];
    for (const [key, v] of Object.entries(entry.forms ?? {})) if (!allowed.includes(key) || typeof v !== "string" || v.length > 1500) throw new Error("Invalid word form field.");
    if (entry.category === "NOUN" && (!entry.forms?.gender?.trim() || !entry.forms?.plural?.trim())) throw new Error("Dictionary nouns require gender and plural (or an explicit no-plural explanation).");
    if (entry.category === "NOUN" && lang === "de" && !["der", "die", "das"].includes(entry.forms.gender)) throw new Error("German noun gender must be der, die or das.");
    if (entry.category === "NOUN" && lang === "de" && !/^\p{Lu}/u.test(entry.word.replace(/^(der|die|das)\s+/i, ""))) throw new Error("German dictionary nouns require capitalization.");
    if (entry.category === "VERB" && (!entry.forms?.past?.trim() || !entry.forms?.perfect?.trim() || !entry.forms?.imperativ?.trim())) throw new Error("Dictionary verbs require past, perfect and imperative forms.");
    if (entry.relatedWords !== undefined) {
      if (!entry.relatedWords || typeof entry.relatedWords !== "object" || Array.isArray(entry.relatedWords)) throw new Error("Invalid related words.");
      for (const [key, values] of Object.entries(entry.relatedWords)) if (!["synonyms", "antonyms", "homophones", "homonymous", "paronyms", "verbFamilies"].includes(key) || !Array.isArray(values) || values.length > 30 || values.some(v => typeof v !== "string" || !v.trim() || v.length > 200)) throw new Error("Invalid related word field.");
    }
  };
  if (value.kind === "LEXEME") {
    const bareLemma = value.lemma.replace(/^(der|die|das)\s+/i, "");
    if (value.key !== translationKey(bareLemma) || value.category === "UNKNOWN") throw new Error("A dictionary entry must match its lemma and have a known grammatical category.");
    if (/\b(?:plural|dative|dativ|genitive|genitiv|accusative|akkusativ|declined|conjugated|finite|inflected|subjunctive|imperative|preterite|imperfect|conditional|participle|past|(?:first|second|third)[ -]person)\b/i.test(value.form)) throw new Error("Explicit non-base morphology cannot be stored as a dictionary entry.");
    if (value.category === "VERB" && !isDictionaryVerb(value.word, language)) throw new Error("A dictionary verb must be an infinitive.");
    forms(value, language);
    const target = value.target;
    if (!target || typeof target.word !== "string" || !target.word.trim() || target.word.length > 200 || !Object.values(GrammaticalCategory).includes(target.category) || target.category === "UNKNOWN" || !CEFR_LEVELS.includes(target.cefrLevel) || typeof target.example !== "string" || !target.example.trim()) throw new Error("Dictionary entries require complete target-language metadata.");
    if (target.word !== target.word.normalize("NFC").trim() || /^[\p{P}\p{S}]|[\p{P}\p{S}]$/u.test(target.word)) throw new Error("Reviewed target spelling must be clean NFC dictionary text without edge punctuation.");
    if (target.category === "VERB" && !isDictionaryVerb(target.word, language === "de" ? "es" : "de")) throw new Error("The target dictionary verb must be an infinitive.");
    forms(target, language === "de" ? "es" : "de");
  }
  return value;
}
export interface TranslationProvenance { origin: "MANUAL" | "GPT"; model?: string; examples: string[]; contexts: string[]; phraseRefs: PhraseReference[] }

async function upsertDictionaryWord(db: Database, language: TranslationLanguage, data: { word: string; category: GrammaticalCategory; cefrLevel: any; forms?: any; relatedWords?: any; notes?: string }, examples: string[], contexts: string[], provenance: TranslationProvenance, session: ClientSession) {
  const candidates = (await exactWords(db, data.word, language, session)).filter(w => !knownCategories(w).length || knownCategories(w).includes(data.category));
  candidates.sort((a, b) => Number(!knownCategories(a).length) - Number(!knownCategories(b).length) || String(a._id).localeCompare(String(b._id)));
  const existing = candidates[0], collection = wordsFor(db, language), now = new Date();
  if (existing) {
    const fill: Record<string, unknown> = { updatedAt: now };
    if (!knownCategories(existing).length) { fill.gramaticalCategories = [data.category]; fill.word = data.word; }
    for (const [key, value] of Object.entries(data.forms ?? {})) if (!existing.forms?.[key]) fill[`forms.${key}`] = value;
    for (const [key, value] of Object.entries({ synonyms: [], antonyms: [], homophones: [], homonymous: [], paronyms: [], verbFamilies: [], ...data.relatedWords })) if (!existing.relatedWords?.[key]?.length) fill[`relatedWords.${key}`] = value;
    if (!existing.cefrLevel || !knownCategories(existing).length) { fill.cefrLevel = data.cefrLevel; fill.level = data.cefrLevel.slice(0, 2); fill.cefrClassification = { level: data.cefrLevel, model: provenance.model ?? "manual-phrase-review", version: 1, classifiedAt: now }; }
    if (!existing.notes || existing.notes === "Autogenerated from phrase seed") fill.notes = data.notes || (provenance.origin === "MANUAL" ? "Dictionary form reviewed during phrase translation seeding." : "Dictionary metadata generated and validated for a production translation miss.");
    await collection.updateOne({ _id: existing._id }, { $set: fill, $addToSet: { examples: { $each: examples }, contexts: { $each: contexts } } }, { session });
    return existing._id;
  }
  const identity = language === "de" ? data.word.replace(/^(der|die|das)\s+/i, "") : data.word;
  const id = stableId(`phrase-lexeme:${language}:${data.category}:${identity.normalize("NFC").toLowerCase()}`);
  const doc: Word = { _id: id, word: data.word, gramaticalCategories: [data.category], forms: data.forms ?? {}, examples, contexts, relatedWords: { synonyms: [], antonyms: [], homophones: [], homonymous: [], paronyms: [], verbFamilies: [], ...data.relatedWords }, notes: data.notes || (provenance.origin === "MANUAL" ? "Dictionary form reviewed for phrase word translation." : "Dictionary metadata generated and validated for a production translation miss."), cefrLevel: data.cefrLevel, level: data.cefrLevel.slice(0, 2), cefrClassification: { level: data.cefrLevel, model: provenance.model ?? "manual-phrase-review", version: 1, classifiedAt: now }, createdAt: now, updatedAt: now };
  await collection.updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true, session });
  return id;
}

/** Shared, validated writer for the reviewed seed and emergency GPT enrichment. */
export async function saveReviewedEntry(db: Database, client: MongoClient, rawEntry: ReviewedTranslation, language: TranslationLanguage, provenance: TranslationProvenance, lease?: { id: ObjectId; token: string }) {
  const entry = validateReviewedEntry(rawEntry, language), targetLanguage: TranslationLanguage = language === "de" ? "es" : "de";
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      if (lease && !await db.translationsEsDe.findOne({ _id: lease.id, leaseToken: lease.token, status: "PENDING" }, { session })) throw new Error("The translation claim expired; retry the lookup.");
      if (entry.kind === "LEXEME") {
        const sourceId = await upsertDictionaryWord(db, language, { ...entry }, provenance.examples, provenance.contexts, provenance, session);
        const targetId = await upsertDictionaryWord(db, targetLanguage, entry.target!, [entry.target!.example], provenance.contexts, provenance, session);
        const main = language === "es" ? sourceId : targetId, translated = language === "de" ? sourceId : targetId;
        if (!await db.relationsWordsEsDe.findOne({ main, translated }, { session })) await db.relationsWordsEsDe.updateOne({ _id: stableId(`word-relation:${main}:${translated}`) }, { $setOnInsert: { _id: stableId(`word-relation:${main}:${translated}`), main, translated, createdAt: new Date() } }, { upsert: true, session });
        const phraseIds = provenance.phraseRefs.filter(r => r.language === language).map(r => r.phraseId);
        if (phraseIds.length) await (language === "de" ? db.phrasesDE : db.phrasesES).updateMany({ _id: { $in: phraseIds } }, { $addToSet: { words: sourceId } }, { session });
        if (lease) await db.translationsEsDe.deleteOne({ _id: lease.id, leaseToken: lease.token }, { session });
        return { word: entry.word, translation: entry.target!.word, source: "WORDS" as const, sourceLanguage: language, targetLanguage };
      }
      const lemmaCandidates = await exactWords(db, entry.lemma, language, session);
      const lemmaWordIds = lemmaCandidates.filter(w => knownCategories(w).length && (entry.category === GrammaticalCategory.UNKNOWN || knownCategories(w).includes(entry.category))).map(w => w._id);
      const filter = lease ? { _id: lease.id, leaseToken: lease.token } : { sourceLanguage: language, targetLanguage, key: entry.key };
      const now = new Date();
      await db.translationsEsDe.updateOne(filter, { $set: { word: entry.word, sourceLanguage: language, targetLanguage, key: entry.key, translation: entry.translation, kind: "SURFACE", lemma: entry.lemma, lemmaWordIds, category: entry.category, form: entry.form, cefrLevel: entry.cefrLevel, notes: entry.notes ?? "", examples: provenance.examples, contexts: provenance.contexts, phraseRefs: provenance.phraseRefs, origin: provenance.origin, ...(provenance.model ? { model: provenance.model } : {}), status: "READY", updatedAt: now }, $setOnInsert: { _id: lease?.id ?? stableId(`surface-translation:${language}:${targetLanguage}:${entry.key}`), createdAt: now }, $unset: { leaseToken: "", leaseUntil: "" } }, { upsert: !lease, session });
      return { word: entry.word, translation: entry.translation, source: "TRANSLATIONS" as const, sourceLanguage: language, targetLanguage };
    });
  } finally {
    // Commit errors can follow successful catalog writes. Invalidate every
    // dictionary outcome; SURFACE translations never modify this catalog.
    if (entry.kind === "LEXEME") invalidateStudyCatalog(db);
    await session.endSession();
  }
}

type LookupInput = { word: unknown; sourceLanguage: unknown; targetLanguage: unknown; context?: unknown };
type TranslationResult = { word?: string; translation?: string; source?: "WORDS" | "TRANSLATIONS"; sourceLanguage?: TranslationLanguage; targetLanguage?: TranslationLanguage; status?: "PENDING"; retryAfterMs?: number };
export function createTranslationService(options: { db: Database; client: MongoClient; emergency?: boolean; generate?: typeof generateTranslation }) {
  const { db, client } = options;
  return { async lookup(input: LookupInput): Promise<TranslationResult> {
    const [sourceLanguage, targetLanguage] = languagePair(input.sourceLanguage, input.targetLanguage);
    const word = cleanTranslationWord(input.word), key = translationKey(word), filter = { sourceLanguage, targetLanguage, key };
    if (input.context !== undefined && (typeof input.context !== "string" || input.context.length > 4000)) throw new Error("Invalid phrase context.");
    const catalog = await lookupCatalogTranslation(db, word, sourceLanguage);
    if (catalog) return catalog;
    const saved = await db.translationsEsDe.findOne(filter);
    if (saved?.status === "READY" && saved.translation?.trim()) return { word, translation: saved.translation, source: "TRANSLATIONS", sourceLanguage, targetLanguage };
    if (!(options.emergency ?? process.env.NODE_ENV === "production")) throw new Error("Emergency translation is enabled only in production. Seed this word for local use.");
    // The compound unique index and expiring lease coordinate across API processes.
    const now = new Date(), token = randomUUID();
    try { await db.translationsEsDe.updateOne(filter, { $setOnInsert: { _id: new ObjectId(), ...filter, word, origin: "GPT", status: "FAILED", createdAt: now, updatedAt: now } }, { upsert: true }); }
    catch (error: any) { if (error.code !== 11000) throw error; }
    const claimed = await db.translationsEsDe.findOneAndUpdate({ ...filter, $or: [{ status: "FAILED" }, { status: "PENDING", leaseUntil: { $lte: now } }] }, { $set: { status: "PENDING", leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now } }, { returnDocument: "after" });
    if (!claimed) {
      const completed = await lookupCatalogTranslation(db, word, sourceLanguage);
      if (completed) return completed;
      const ready = await db.translationsEsDe.findOne(filter);
      if (ready?.status === "READY" && ready.translation) return { word, translation: ready.translation, source: "TRANSLATIONS", sourceLanguage, targetLanguage };
      return { status: "PENDING", retryAfterMs: 1000 };
    }
    try {
      // Another request can create the dictionary pair and remove its claim
      // between our initial reads and this claim. Recheck before calling GPT.
      const completed = await lookupCatalogTranslation(db, word, sourceLanguage);
      if (completed) {
        await db.translationsEsDe.deleteOne({ _id: claimed._id, leaseToken: token, status: "PENDING" });
        return completed;
      }
      const reviewed = await (options.generate ?? generateTranslation)(word, sourceLanguage, typeof input.context === "string" ? input.context : "");
      if (reviewed.key !== key) throw new Error("Translation enrichment changed the requested word.");
      if (typeof reviewed.example !== "string" || !reviewed.example.trim() || reviewed.example.length > 4000 || !Array.isArray(reviewed.contexts) || reviewed.contexts.some(x => !Object.values(LearningContext).includes(x as LearningContext))) throw new Error("Translation enrichment omitted its source example or contexts.");
      return await saveReviewedEntry(db, client, reviewed, sourceLanguage, { origin: "GPT", model: READING_MODEL, examples: [reviewed.example], contexts: reviewed.contexts, phraseRefs: [] }, { id: claimed._id, token });
    } catch (error) {
      await db.translationsEsDe.updateOne({ _id: claimed._id, leaseToken: token }, { $set: { status: "FAILED", updatedAt: new Date() }, $unset: { leaseToken: "", leaseUntil: "" } });
      throw error;
    }
  } };
}
export function translatePhraseWord(input: LookupInput) {
  return createTranslationService({ db: getDb(), client: getDatabaseClient() }).lookup(input);
}
