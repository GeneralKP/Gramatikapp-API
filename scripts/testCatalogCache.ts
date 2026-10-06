import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { CATALOG_SUMMARY_TTL_MS, catalogSummaryCache, createCatalogSummaryCache } from "../src/features/progress/catalogSummaryCache.js";
import { processSeedData } from "../src/features/phrases/seedService.js";
import type { Database } from "../src/lib/database.js";
import { CATALOG_SUMMARY_REFRESH_MS, startStudyCatalogRefresh, stopStudyCatalogRefresh } from "../src/features/progress/studyLoading.js";

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
console.log("PASS immutable catalog summaries, database isolation, singleflight, atomic refresh, hard expiry, retryable loads, generation-safe invalidation, timer lifecycle and partially failed seed imports");
