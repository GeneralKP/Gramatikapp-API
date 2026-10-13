import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { CATALOG_SUMMARY_TTL_MS, catalogSummaryCache, createCatalogSummaryCache } from "../src/features/progress/catalogSummaryCache.js";
import { processSeedData } from "../src/features/phrases/seedService.js";
import type { Database } from "../src/lib/database.js";
import { CATALOG_SUMMARY_REFRESH_MS, startStudyCatalogRefresh, stopStudyCatalogRefresh } from "../src/features/progress/studyLoading.js";
import { studyTextCatalog } from "../src/features/progress/studyTextCatalog.js";
import { saveReviewedEntry } from "../src/features/translations/translations.service.js";
import { fixtureCatalogAggregate } from "./fixtures/catalogAggregate.js";
import { createPhraseGrammarIndex } from "../src/features/phrases/phraseGrammar.js";

let now = 0;
const cache = createCatalogSummaryCache(() => now), db = {} as Database, secondDb = {} as Database;
const source = [{ _id: new ObjectId(), contexts: ["university"], level: "A1" }];
let reads = 0, release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const load = async () => { reads++; await gate; return source; };
const first = cache.read(db, "wordMeta", load), simultaneous = cache.read(db, "wordMeta", load);
assert.equal(first, simultaneous, "concurrent requests share one catalog load");
await Promise.resolve(); assert.equal(reads, 1); release();
const rows = await first;
assert.deepEqual(rows, source);
assert.notEqual(rows, source); assert.notEqual(rows[0], source[0]); assert.notEqual(rows[0].contexts, source[0].contexts);
assert.equal(rows[0]._id, source[0]._id, "ObjectId semantics survive copying");
assert.throws(() => rows.push(source[0]), TypeError);
assert.throws(() => rows[0].contexts.push("work"), TypeError);
assert.throws(() => { rows[0].level = "B1"; }, TypeError);
assert.deepEqual(source[0].contexts, ["university"], "freezing summaries never freezes mocked/source rows");
assert.ok(!Object.isFrozen(source[0].contexts));
assert.equal(await cache.read(db, "wordMeta", async () => { throw new Error("cached part must not reload"); }), rows);
assert.equal((await cache.read(secondDb, "wordMeta", async () => [{ _id: source[0]._id, contexts: ["work"], level: "B1" }]))[0].level, "B1", "database instances never share cached summaries");
now = CATALOG_SUMMARY_TTL_MS - 1;
assert.equal(await cache.read(db, "wordMeta", async () => source), rows);
now++;
const expired = await cache.read(db, "wordMeta", async () => { reads++; return source; });
assert.notEqual(expired, rows); assert.equal(reads, 2, "expiry reloads even at the exact TTL boundary");
const failure = new Error("catalog unavailable");
await assert.rejects(cache.read(db, "phrases", async () => { throw failure; }), error => error === failure);
assert.deepEqual(await cache.read(db, "phrases", async () => []), [], "failed loads are retryable");
let releaseOld!: () => void;
const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
const obsolete = cache.read(db, "words", async () => { await oldGate; return [{ version: 1 }]; });
cache.invalidate(db);
const latest = await cache.read(db, "words", async () => [{ version: 2 }]);
releaseOld(); assert.deepEqual(await obsolete, [{ version: 1 }]);
assert.equal(await cache.read(db, "words", async () => []), latest, "an invalidated in-flight read cannot restore an obsolete entry");

// A content signature validation must preserve the same immutable generation
// when the projected catalog is unchanged, including at the hard deadline.
const validatedCache = createCatalogSummaryCache(() => now);
now = 0;
let snapshotLoads = 0, signatureChecks = 0;
const unchangedSource = Object.assign(async () => { snapshotLoads++; return [{ version: 1 }]; }, {
  async loadSnapshot() { snapshotLoads++; return { rows: [{ version: 1 }], signature: "1:42:84" }; },
  async readSignature() { signatureChecks++; return "1:42:84"; },
});
const validated = await validatedCache.read(db, "words", unchangedSource);
now = CATALOG_SUMMARY_REFRESH_MS;
assert.equal(await validatedCache.refresh(db, "words", unchangedSource), validated, "unchanged refresh retains exact array identity");
assert.equal(snapshotLoads, 1, "unchanged refresh never transfers the full catalog again");
assert.equal(signatureChecks, 1);
now += CATALOG_SUMMARY_TTL_MS;
assert.equal(await validatedCache.read(db, "words", unchangedSource), validated, "unchanged hard expiry validates and retains the frozen generation");
assert.equal(snapshotLoads, 1); assert.equal(signatureChecks, 2);

// Changed signatures reload their own part, with singleflight checks/reloads.
let changedSignature = "1:100:200", changedVersion = 2;
let changedLoads = 0, changedChecks = 0, checkRelease!: () => void, loadRelease!: () => void, loadStarted!: () => void;
let signalLoad = false;
const loadingStarted = new Promise<void>(resolve => { loadStarted = resolve; });
let checkGate: Promise<void> = Promise.resolve(), loadGate: Promise<void> = Promise.resolve();
const changedSource = {
  async loadSnapshot() { changedLoads++; if (signalLoad) loadStarted(); const rows = [{ version: changedVersion }], signature = changedSignature; await loadGate; return { rows, signature }; },
  async readSignature() { changedChecks++; await checkGate; return changedSignature; },
};
const changedRows = await validatedCache.read(db, "phrases", changedSource);
changedSignature = "1:101:202"; changedVersion = 3;
now += CATALOG_SUMMARY_REFRESH_MS;
signalLoad = true;
checkGate = new Promise(resolve => { checkRelease = resolve; });
loadGate = new Promise(resolve => { loadRelease = resolve; });
const checking = validatedCache.refresh(db, "phrases", changedSource);
assert.equal(validatedCache.refresh(db, "phrases", changedSource), checking, "concurrent signature checks share the same promise");
assert.equal(await validatedCache.read(db, "phrases", changedSource), changedRows, "fresh reads remain immediate during a signature check");
now += CATALOG_SUMMARY_REFRESH_MS;
assert.equal(validatedCache.read(db, "phrases", changedSource), checking, "hard-expired reads await the same signature check/reload");
checkRelease(); await loadingStarted;
assert.equal(validatedCache.read(db, "phrases", changedSource), checking, "changed part loads remain singleflight");
loadRelease(); const changedReplacement = await checking;
assert.equal(changedReplacement[0].version, 3); assert.notEqual(changedReplacement, changedRows);
assert.equal(changedLoads, 2); assert.equal(changedChecks, 1);
assert.equal(await validatedCache.read(db, "words", unchangedSource), validated, "a changed phrase signature leaves the word generation intact");
assert.equal(snapshotLoads, 1);

// A failed validation cannot move the old deadline. Expired reads retry and
// propagate the error rather than silently serving stale catalog content.
const validationFailure = new Error("signature unavailable");
let probeFails = true;
const retrySource = { ...changedSource, async readSignature() { changedChecks++; if (probeFails) throw validationFailure; return changedSignature; } };
now += CATALOG_SUMMARY_REFRESH_MS;
await assert.rejects(validatedCache.refresh(db, "phrases", retrySource), error => error === validationFailure);
assert.equal(await validatedCache.read(db, "phrases", retrySource), changedReplacement);
now += CATALOG_SUMMARY_REFRESH_MS;
await assert.rejects(validatedCache.read(db, "phrases", retrySource), error => error === validationFailure);
probeFails = false;
assert.equal(await validatedCache.read(db, "phrases", retrySource), changedReplacement, "expired validation failures are retryable");

// A failed replacement after a changed probe also retains the original hard
// deadline. At expiry the next request must retry the load and expose failures.
const failingReloadCache = createCatalogSummaryCache(() => now);
let reloadSignature = "old", reloadFails = false;
const failingReloadSource = {
  async loadSnapshot() { if (reloadFails) throw validationFailure; return { rows: [{ version: reloadSignature }], signature: reloadSignature }; },
  async readSignature() { return reloadSignature; },
};
const preFailure = await failingReloadCache.read(db, "words", failingReloadSource);
now += CATALOG_SUMMARY_REFRESH_MS; reloadSignature = "new"; reloadFails = true;
await assert.rejects(failingReloadCache.refresh(db, "words", failingReloadSource), error => error === validationFailure);
assert.equal(await failingReloadCache.read(db, "words", failingReloadSource), preFailure);
now += CATALOG_SUMMARY_REFRESH_MS;
await assert.rejects(failingReloadCache.read(db, "words", failingReloadSource), error => error === validationFailure);
reloadFails = false;
assert.deepEqual(await failingReloadCache.read(db, "words", failingReloadSource), [{ version: "new" }]);

// Writer invalidation beats both the signature-check and snapshot-load phases.
for (const phase of ["check", "load"] as const) {
  const raceCache = createCatalogSummaryCache(() => now);
  let raceSignature = "old", raceVersion = 1, releaseRace!: () => void;
  let raceGate = Promise.resolve(), racing = false, reachedPhase!: () => void;
  const phaseStarted = new Promise<void>(resolve => { reachedPhase = resolve; });
  const raceSource = {
    async loadSnapshot() { const rows = [{ version: raceVersion }], signature = raceSignature; if (phase === "load") { if (racing) reachedPhase(); await raceGate; } return { rows, signature }; },
    async readSignature() { if (phase === "check") { if (racing) reachedPhase(); await raceGate; } return raceSignature; },
  };
  await raceCache.read(db, "words", raceSource);
  raceSignature = "changed"; raceVersion = 2; racing = true;
  raceGate = new Promise(resolve => { releaseRace = resolve; });
  const priorValidation = raceCache.refresh(db, "words", raceSource);
  await phaseStarted;
  raceCache.invalidate(db, "words");
  const afterInvalidation = await raceCache.read(db, "words", { async loadSnapshot() { return { rows: [{ version: 3 }], signature: "newest" }; }, async readSignature() { return "newest"; } });
  releaseRace(); await priorValidation;
  assert.equal(await raceCache.read(db, "words", raceSource), afterInvalidation, `invalidation during ${phase} cannot restore the older generation`);
}

// The probe observed a revision just before another writer. Bind the replacement
// to its own rows/signature so the next validation cannot bless the wrong rows.
const baselineCache = createCatalogSummaryCache(() => now);
let baselineVersion = 1, baselineSignature = "1", baselineLoads = 0;
const baselineSource = {
  async loadSnapshot() { baselineLoads++; return { rows: [{ version: baselineVersion }], signature: baselineSignature }; },
  async readSignature() { const signature = baselineSignature; baselineVersion = 3; baselineSignature = "3"; return signature; },
};
await baselineCache.read(db, "words", baselineSource);
baselineVersion = 2; baselineSignature = "2";
const boundSnapshot = await baselineCache.refresh(db, "words", baselineSource);
assert.equal(boundSnapshot[0].version, 3);
assert.equal(await baselineCache.refresh(db, "words", baselineSource), boundSnapshot);
assert.equal(baselineLoads, 2, "the cached baseline is the loaded-row signature, not the earlier probe");

// Refreshes replace the old generation only after the new summary is complete.
// Reads before the hard deadline continue immediately; after it they must wait.
const refreshCache = createCatalogSummaryCache(() => now);
now = 0;
const old = await refreshCache.read(db, "words", async () => [{ version: 1 }]);
now = CATALOG_SUMMARY_REFRESH_MS;
let releaseRefresh!: () => void;
const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
const refreshLoad = async () => { await refreshGate; return [{ version: 2 }]; };
const background = refreshCache.refresh(db, "words", refreshLoad);
assert.equal(refreshCache.refresh(db, "words", refreshLoad), background, "background refreshes are singleflight");
assert.equal(await refreshCache.read(db, "words", async () => []), old, "fresh reads never wait for a background replacement");
now = CATALOG_SUMMARY_TTL_MS;
assert.equal(refreshCache.read(db, "words", async () => []), background, "hard-expired reads await the replacement and never use the old summary");
releaseRefresh();
const replacement = await background;
assert.deepEqual(replacement, [{ version: 2 }]);
assert.equal(await refreshCache.read(db, "words", async () => []), replacement);
now += CATALOG_SUMMARY_REFRESH_MS;
await assert.rejects(refreshCache.refresh(db, "words", async () => { throw failure; }), error => error === failure);
assert.equal(await refreshCache.read(db, "words", async () => []), replacement, "refresh errors retain a still-fresh value");
now += CATALOG_SUMMARY_REFRESH_MS;
assert.deepEqual(await refreshCache.read(db, "words", async () => [{ version: 3 }]), [{ version: 3 }], "refresh errors never extend the hard maximum age");
let releaseObsoleteRefresh!: () => void;
const obsoleteRefreshGate = new Promise<void>(resolve => { releaseObsoleteRefresh = resolve; });
const obsoleteRefresh = refreshCache.refresh(db, "words", async () => { await obsoleteRefreshGate; return [{ version: 4 }]; });
refreshCache.invalidate(db);
const afterWrite = await refreshCache.read(db, "words", async () => [{ version: 5 }]);
releaseObsoleteRefresh(); await obsoleteRefresh;
assert.equal(await refreshCache.read(db, "words", async () => []), afterWrite, "catalog mutation invalidation wins against an older background refresh");

// The existing text parts also hold shared catalog display/feedback fields,
// with the same immutable generations. Per-card/private state stays outside.
const displaySource: Record<string, any[]> = {
  wordsES: [{ _id: new ObjectId(), word: "casa", contexts: ["university"], level: "A1", examples: ["catalog Spanish example"], notes: "unused" }],
  wordsDE: [{ _id: new ObjectId(), word: "Haus", gramaticalCategories: ["NOUN"], forms: { gender: "das", past: "ging", perfect: "gegangen", imperativ: "geh", plural: "unused" }, notes: "catalog note", examples: ["catalog German example"], userId: "private", scheduler: { private: true } }],
  phrasesES: [{ _id: new ObjectId(), phrase: "Hoy estudio alemán.", contexts: ["university"], level: "A1" }],
  phrasesDE: [{ _id: new ObjectId(), phrase: "Heute lerne ich Deutsch.", synonyms: ["Heute übe ich Deutsch."], words: ["unused"], perWordExplanation: { private: true } }],
};
const displayReads: { collection: string; projection: any }[] = [];
const displayDb = Object.fromEntries(Object.keys(displaySource).map(collection => [collection, {
  aggregate(pipeline: any[]) {
    const filter = pipeline[0].$match, fields = pipeline[1].$project;
    assert.deepEqual(filter, {}, "static display cache never filters or reads by account");
    if (!pipeline.some(stage => stage.$group)) displayReads.push({ collection, projection: fields });
    const projected = displaySource[collection].map(row => {
      const result: any = {};
      for (const key of Object.keys(fields)) {
        const [parent, child] = key.split(".");
        if (child) { if (row[parent] && typeof row[parent] === "object") { result[parent] ??= {}; if (row[parent][child] !== undefined) result[parent][child] = row[parent][child]; } }
        else if (row[key] !== undefined) result[key] = row[key];
      }
      return result;
    });
    return { batchSize(size: number) { assert.equal(size, 5000); return this; }, async toArray() { return fixtureCatalogAggregate(projected, pipeline); } };
  },
}])) as unknown as Database;
for (const privatePart of ["users", "progress", "schedulerProfiles", "reviewEvents"]) Object.defineProperty(displayDb, privatePart, { get() { throw new Error("Private state must never enter the static display cache"); } });
const display = await studyTextCatalog(undefined, displayDb);
assert.equal(displayReads.length, 4);
assert.deepEqual(displayReads.find(read => read.collection === "wordsES")!.projection, { _id: 1, word: 1, contexts: 1, level: 1, examples: 1 });
assert.deepEqual(displayReads.find(read => read.collection === "wordsDE")!.projection, { _id: 1, word: 1, cefrLevel: 1, gramaticalCategories: 1, "forms.gender": 1, "forms.past": 1, "forms.perfect": 1, "forms.imperativ": 1, notes: 1, examples: 1 });
assert.deepEqual(displayReads.find(read => read.collection === "phrasesDE")!.projection, { _id: 1, phrase: 1, cefrLevel: 1, synonyms: 1, words: 1 });
assert.deepEqual(Object.keys(display.wordsES[0]).sort(), ["_id", "word", "contexts", "level", "examples"].sort());
assert.deepEqual(Object.keys(display.wordsDE[0]).sort(), ["_id", "word", "gramaticalCategories", "forms", "notes", "examples"].sort());
assert.deepEqual(Object.keys(display.wordsDE[0].forms!).sort(), ["gender", "past", "perfect", "imperativ"].sort());
assert.deepEqual(Object.keys(display.phrasesDE[0]).sort(), ["_id", "phrase", "synonyms", "words"].sort());
assert.throws(() => { display.wordsDE[0].forms!.past = "mutated"; }, TypeError);
assert.throws(() => display.wordsDE[0].gramaticalCategories.push("VERB" as any), TypeError);
assert.throws(() => display.phrasesDE[0].synonyms.push("mutated"), TypeError);
assert.throws(() => display.wordsES[0].examples.push("mutated"), TypeError);
assert.throws(() => display.wordsDE[0].examples.push("mutated"), TypeError);
assert.equal((display.wordsDE[0] as any).userId, undefined); assert.equal((display.wordsDE[0] as any).scheduler, undefined);
displaySource.wordsES[0] = { ...displaySource.wordsES[0], examples: ["edited Spanish example"] };
displaySource.wordsDE[0] = { ...displaySource.wordsDE[0], word: "Gehen", forms: { ...displaySource.wordsDE[0].forms, past: "edited" }, notes: "edited catalog note", examples: ["edited German example"] };
displaySource.phrasesDE[0] = { ...displaySource.phrasesDE[0], synonyms: ["edited alternative"] };
const stillFresh = await studyTextCatalog(undefined, displayDb);
assert.equal(displayReads.length, 4); assert.equal(stillFresh.wordsDE, display.wordsDE); assert.equal(stillFresh.wordsDE[0].forms!.past, "ging");
assert.equal(stillFresh.wordsDE[0].notes, "catalog note"); assert.deepEqual(stillFresh.wordsDE[0].examples, ["catalog German example"]); assert.deepEqual(stillFresh.wordsES[0].examples, ["catalog Spanish example"]);
const refreshedDisplay = await studyTextCatalog(undefined, displayDb, true);
assert.equal(refreshedDisplay.wordsDE[0].word, "Gehen"); assert.equal(refreshedDisplay.wordsDE[0].forms!.past, "edited"); assert.deepEqual(refreshedDisplay.phrasesDE[0].synonyms, ["edited alternative"]);
assert.equal(refreshedDisplay.wordsDE[0].notes, "edited catalog note"); assert.deepEqual(refreshedDisplay.wordsDE[0].examples, ["edited German example"]); assert.deepEqual(refreshedDisplay.wordsES[0].examples, ["edited Spanish example"]);
assert.equal(display.wordsDE[0].forms!.past, "ging", "a replacement never mutates the earlier request's snapshot");
catalogSummaryCache.invalidate(displayDb);
const invalidatedDisplay = await studyTextCatalog(undefined, displayDb);
assert.notEqual(invalidatedDisplay.wordsDE, refreshedDisplay.wordsDE, "catalog invalidation replaces enriched display generations too");
assert.equal(displayReads.length, 11, "refresh loads only three changed text parts; invalidation reloads all four parts");

const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
let starts = 0, stops = 0, unrefs = 0;
const fakeTimer = { unref() { unrefs++; } } as any;
globalThis.setInterval = ((callback: () => void, delay: number) => {
  assert.equal(delay, 15_000); assert.equal(typeof callback, "function"); starts++; return fakeTimer;
}) as any;
globalThis.clearInterval = ((timer: any) => { assert.equal(timer, fakeTimer); stops++; }) as any;
try {
  assert.equal(starts, 0, "importing helper modules never starts background database work");
  startStudyCatalogRefresh(); startStudyCatalogRefresh();
  assert.equal(starts, 1); assert.equal(unrefs, 1, "refresh timer cannot keep a shutdown process alive");
  stopStudyCatalogRefresh(); stopStudyCatalogRefresh(); assert.equal(stops, 1);
} finally { stopStudyCatalogRefresh(); globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval; }

// Seed imports can commit early inserts and then fail. Their summaries must be
// discarded even when the last operation throws; no network is involved.
const partialDb = {
  wordsDE: { async findOne() { return null; }, async insertOne() {} },
  wordsES: { async findOne() { throw failure; } },
} as unknown as Database;
const before = await catalogSummaryCache.read(partialDb, "words", async () => [{ version: 1 }]);
await assert.rejects(processSeedData(partialDb, {
  words_de: [{ tempId: "de", word: "Haus", gramaticalCategories: [], examples: [], contexts: [] }],
  words_es: [{ tempId: "es", word: "casa", gramaticalCategories: [], examples: [], contexts: [] }],
  word_relations: [], phrases_de: [], phrases_es: [], phrase_relations: [],
}), error => error === failure);
assert.notEqual(await catalogSummaryCache.read(partialDb, "words", async () => [{ version: 2 }]), before);

// The reviewed dictionary writer is also used by emergency translations. Its
// catalog generations are invalidated on successful or uncertain transactions,
// while SURFACE-only translations invalidate only their category projection.
const reviewed = {
  kind: "LEXEME", word: "lernen", key: "lernen", lemma: "lernen", translation: "aprender", form: "dictionary form", category: "VERB", cefrLevel: "A1.1",
  forms: { past: "lernte", perfect: "gelernt", imperativ: "Lerne!" },
  target: { word: "aprender", category: "VERB", cefrLevel: "A1.1", forms: { past: "aprendió", perfect: "aprendido", imperativ: "aprende" }, example: "Quiero aprender alemán." },
} as any;
const provenance = { origin: "MANUAL" as const, examples: ["Ich lerne Deutsch."], contexts: ["university"], phraseRefs: [] };
let catalogWrites = 0, surfaceWrites = 0, endedSessions = 0, uncertainCommit = false, rejectTransaction = false, rejectCleanup = false;
const dictionary = { find() { return { async toArray() { return []; } }; }, async updateOne() { catalogWrites++; } };
const reviewedDb = { wordsDE: dictionary, wordsES: dictionary, relationsWordsEsDe: { async findOne() { return null; }, async updateOne() { catalogWrites++; } }, translationsEsDe: { async updateOne() { surfaceWrites++; } } } as unknown as Database;
const reviewedClient = { startSession() { return { async withTransaction(work: () => Promise<unknown>) { if (rejectTransaction) throw failure; const result = await work(); if (uncertainCommit) throw failure; return result; }, async endSession() { endedSessions++; if (rejectCleanup) throw failure; } }; } } as any;
async function boundedReviewedSave(entry = reviewed) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([saveReviewedEntry(reviewedDb, reviewedClient, entry, "de", provenance), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Mocked dictionary write timed out")), 3000); })]);
  } finally { clearTimeout(timer!); }
}
for (const outcome of ["success", "transaction rejection", "uncertain commit", "cleanup rejection"]) {
  uncertainCommit = outcome === "uncertain commit"; rejectTransaction = outcome === "transaction rejection"; rejectCleanup = outcome === "cleanup rejection";
  const priorText = await catalogSummaryCache.read(reviewedDb, "wordTextDe", async () => [{ version: catalogWrites }]);
  const priorRelations = await catalogSummaryCache.read(reviewedDb, "words", async () => [{ version: catalogWrites }]);
  if (outcome !== "success") await assert.rejects(boundedReviewedSave(), error => error === failure);
  else assert.equal((await boundedReviewedSave())?.source, "WORDS");
  assert.notEqual(await catalogSummaryCache.read(reviewedDb, "wordTextDe", async () => [{ version: catalogWrites }]), priorText, `dictionary display invalidation survives ${outcome}`);
  assert.notEqual(await catalogSummaryCache.read(reviewedDb, "words", async () => [{ version: catalogWrites }]), priorRelations, `dictionary relation invalidation survives ${outcome}`);
}
uncertainCommit = false; rejectTransaction = false; rejectCleanup = false;
const beforeSurface = await catalogSummaryCache.read(reviewedDb, "wordTextDe", async () => []);
const beforeGrammar = await catalogSummaryCache.read(reviewedDb, "grammarSurfaceDe", async () => []);
assert.deepEqual(createPhraseGrammarIndex([], beforeGrammar).forPhrase('lernte'), { lernte: ['UNKNOWN'] });
const catalogWritesBeforeSurface = catalogWrites;
assert.equal((await boundedReviewedSave({ ...reviewed, kind: "SURFACE", word: "lernte", key: "lernte", form: "past singular" }))?.source, "TRANSLATIONS");
assert.equal(await catalogSummaryCache.read(reviewedDb, "wordTextDe", async () => []), beforeSurface);
const afterGrammar = await catalogSummaryCache.read(reviewedDb, "grammarSurfaceDe", async () => [{ key: 'lernte', category: 'VERB' }]);
assert.notEqual(afterGrammar, beforeGrammar, 'a SURFACE save invalidates its category projection immediately');
assert.deepEqual(createPhraseGrammarIndex([], afterGrammar).forPhrase('lernte'), { lernte: ['VERB'] });
assert.equal(catalogWrites, catalogWritesBeforeSurface); assert.equal(surfaceWrites, 1); assert.equal(endedSessions, 5);
console.log("PASS immutable catalog summaries, unchanged signature identity/no bulk loads, changed-part reloads, loaded-row baselines, database isolation, singleflight checks/loads, hard expiry/failure retries, check/load invalidation, timer lifecycle, shared display/feedback and seed/dictionary writers");
