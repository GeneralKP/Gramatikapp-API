# Study curriculum audit · 11 October 2026 · historical capture

> This saved registry predates the adaptive phrase change. Its level-order and query evidence remains the recorded result; its phrase interval traces describe the earlier fixed policy. See [current phrase scheduling](../phrase-adaptive-scheduling.md).

The actual catalog and the designated test account’s copied progress completed **183 simulated days and 56,082 persisted answers**: 54,199 word answers and 1,883 phrase answers. All **6,242 playable word relations and 269 phrase relations** were introduced in ascending German sublevel order, from A1.1 through C2.2. The run recorded **zero introduction-order violations, early regular reviews, preview/persistence mismatches or descending ordinary answer choices**.

Open [the offline registry](index.html) to filter by day, type, level, first introduction, due review and German text. [CSV](registry.csv) supports spreadsheet inspection; [JSONL](registry.jsonl) retains every displayed option and precise selected/saved date. [Summary](summary.json) contains daily totals and actual MongoDB query plans. The viewer works without a server or network.

## Findings and changes

Previously, catalog cursor order and an existing pending queue could put a later-level introduction ahead of unseen A1 cards. New selection now merges pending and unseen relations by the **German target’s `cefrLevel`**, through all twelve sublevels. Spanish classification cannot override the target level. Within a level, pending groups precede unseen relations, while existing imported positions break pending ties. Unclassified self-contained imports follow C2.2; a broad A1–C2 band cannot invent a missing sublevel.

Word recognition precedes production. Selected legacy words alone are converted into native pairs; a small starter no longer needs to convert every pending later-level word. An odd final daily allowance can introduce recognition alone. Subsequent due reviews retain chronological/scheduler priority and can revisit earlier levels; ascending order applies to **first introductions**, not every review appearing in the session.

Legacy relations missing either bilingual endpoint are excluded from retrieval and playable totals/counters without deleting saved progress. Fresh pending probes include `failureIndex`, so another device’s updated failure count cannot be hidden by an unchanged schedule version/timestamp.

Counters previously treated any pending NEW card as proof that no unseen card needed counting. One pending phrase could advertise one card while retrieval returned twelve; suspended/buried recognition could advertise zero while retrieval filled from unseen words. Counters now use fresh **typed** identity exclusions and the same pure introduction-budget planner as allocation, then apply deck ceilings. This also covers imported decks with different quotas. Only selected virtual pairs are constructed, and count queries perform no writes. A WORD ID cannot hide a PHRASE with the same collection-local ID.

## Data and simulation boundary

The read-only source snapshot was taken at **2026-10-10T22:19:23.015Z**. It contained the existing designated account’s **40 progress rows**: ten pending word relations in both directions and twenty pending phrases, with no review receipts, card edits or scheduler profiles. The private BSON source remains in ignored `.local/study-level-audit/` and is not part of this report. No password or database credential is stored in these artifacts.

Large simulations clone that snapshot into a unique disposable database on **127.0.0.1:27019**. They retain the same owner identity and existing pending progress, advance the API’s clock, and invoke the actual queue loader and transactional sync service. No synthetic review, clock, allowance or user is sent to production. The earlier hosted-web sign-in used the existing account; it submitted no study answer.

This catalog-exhaustion run covers **11 October 2026–11 April 2027**, with up to **200 word relations / 400 directional cards** and **100 phrases** introduced daily, plus due reviews. Fixture allowances were enlarged only locally. NEW/learning cards receive Easy; established words use Good/Easy and phrases Hard to exercise repeated due cycles. Every review receipt’s saved date is checked against its chosen preview. Minute learn-ahead is recorded separately from forbidden early regular review. There are 6,511 first introductions; 6,232 word relations and 249 phrases were newly allocated, with the rest already pending in the source.

The stress run used local `w=1&journal=false` to reduce replica-set commit overhead. It still exercises MongoDB transactions and saved receipt equality, but is not a durability or production-load benchmark. The separate performance measurements use the ordinary loopback URI. The fixture database is dropped in `finally`.

| Level | Word relations | Word introduction days | Phrases | Phrase introduction days |
|---|---:|---|---:|---|
| A1.1 | 509 | 1–3 | 4 | 1 |
| A1.2 | 478 | 3–5 | 3 | 1 |
| A2.1 | 843 | 5–10 | 5 | 1 |
| A2.2 | 617 | 10–13 | 10 | 1 |
| B1.1 | 936 | 13–17 | 10 | 1 |
| B1.2 | 940 | 17–22 | 15 | 1 |
| B2.1 | 1,062 | 22–27 | 34 | 1 |
| B2.2 | 400 | 27–29 | 80 | 1–2 |
| C1.1 | 353 | 29–31 | 64 | 2–3 |
| C1.2 | 75 | 31–32 | 40 | 3 |
| C2.1 | 26 | 32 | 2 | 3 |
| C2.2 | 3 | 32 | 2 | 3 |

Words reach C2.2 on day 32; the much smaller phrase catalog reaches it on day 3. Remaining days verify repeated retrieval and saved due intervals. Catalog completeness here means every available bilingual relation, not that each CEFR level has equal teaching coverage.

## Interval policy

Words and phrases share initial learning machinery. Established phrases use fixed **Again 7 / Hard 30 / Good 180 / Easy 365 days**. They do **not** use an adaptive word algorithm with larger multipliers, and their intervals do not grow with review count. This task preserves that existing policy and tests it explicitly. Word growth depends on grade, ease, elapsed time, lapses and configured caps, rather than a linear lifetime-review rate.

The [interval audit](../study-interval-audit.md) documents six-month small daily sessions, every phrase grade, exact boundaries, DST, retries, Undo, mistakes, Revisit completion and valid configured ties. It also records the fixes for misleading equal Revisit choices, rounded-label collisions and expired legacy phrase temporary dates. The stress run’s ordinary choices were strictly ascending; it does not assert that all configured scheduler states must have distinct times.

## Verification

- Pure unit tests cover all twelve levels, reverse catalog insertion, conflicting Spanish classification, both missing endpoint variants, cache generation changes, imported order, word pairs and a one-card quota. API and web CI now run these curriculum units; native verification already includes its queue tests.
- Disposable real-Mongo tests cover all twelve levels for both types, pending C2 versus unseen A1, actual saved option dates, exhausted counters, dangling progress, bounded legacy conversion, fresh failures, concurrent reloads, partial/blocked frontiers, typed identity collisions, mixed budgets, imported deck ceilings and count reads performing no writes.
- Real Chrome plus the local HTTP API reviews **24 word cards and 12 phrases**, using one actual catalog relation per level. Recognition/reveal, production input, starter hydration, ascending targets and saved receipts are checked.
- Web queue tests and native queue tests preserve all twelve levels through mixing, adaptive batches and rebalancing. The full native suite passes **263 tests / 36 suites**, with strict type checking; web production build and study interval/progressive-loading checks pass. Native evidence is source/unit verification in this task, not a new device build or walkthrough.
- Existing API loading response contracts, catalog cache, scheduler and sync-validation suites are checked alongside the new tests. The canonical standalone database diagram documents the shared data flow; its Study loading, Practice & sync and Native mobile views render offline without errors.
- The 56,082-answer run preceded the final counter-only fix. The shared allocation loop was extracted without changing its decisions; real-database counter/deck regressions and all twelve-level retrieval tests were rerun afterward. Its captured artifacts remain the original full-run evidence.

## Retrieval performance and independent review

Two independent subagents reviewed retrieval correctness and query cost. Static relation/text generations produce one cached in-memory CEFR index. Owner state is read fresh, never cached across requests. The fresh owner identity aggregation groups `itemType + (relationId ?? itemId)`, retaining both directions, null/missing legacy IDs, suspended/superseded exclusions and owner isolation. Selected hydration uses bounded indexed IDs; no per-card level query, request-time catalog `$lookup` or blocking sort was introduced.

At 12,753 late-course owner cards, grouped identities return 6,511 rows rather than both directional rows. The measured 100-pending-word case reduced response BSON from **1,052,137 to 442,205 bytes**, about **58%**, and from nine commands to eight. All examined owner/allocation/hydration plans use indexes with no collection scan or blocking sort. Owner-wide freshness still examines owner progress; this is not constant-time retrieval.

| Pending cards | Word median | Phrase median | Mixed median |
|---:|---:|---:|---:|
| 100 | 89.03 ms | 5.06 ms | 95.64 ms |
| 500 | 105.73 ms | 9.87 ms | 109.73 ms |
| 1,000 | 116.12 ms | 9.50 ms | 123.77 ms |

Phrase pending counts cap at the actual 269-card catalog. [Measurements](performance.json) contain seven samples after a warmup, command/byte/row/CPU counts and actual explains. Their p95 is the sample maximum, not a production tail estimate; concurrent local simulation can contend for resources. [Before-grouping evidence](performance-before-grouping.json) is retained.

These figures measure selection without response counters. The final [starter-with-counters benchmark](performance-with-counts.json) measures the actual `includeCounts=true` path with twenty playable cards, three samples after a warmup: WORD/MIXED medians are 123–190 ms and PHRASE medians 9–15 ms. It performs twelve WORD/MIXED read commands or eight PHRASE commands, with no catalog reads or `$lookup`. Counter totals match eligible pending cards for all cases. The extra fresh grouped identity read preserves snapshot/owner correctness; no per-card query is added. Small local samples establish observed cost, not a production latency guarantee.

A proposed owner/GUID index made normal sibling probes faster, but changed which duplicate recognition card an unsorted legacy query selected, changing production eligibility. It was rejected for this task; [sanitized comparison evidence](guid-index-evaluation.json) records the measured gains and the duplicate-direction counterexample. The compact two-row probe retains the original full-query fallback when duplicates make order ambiguous. No index migration or deployed database change was performed.

## Reproduction

Run inside the API repository using Node 24 and a disposable MongoDB replica set at the guarded loopback address:

```sh
npm run test:study-curriculum
MONGODB_URI=mongodb://127.0.0.1:27019/gramatikapp npm run test:study-curriculum-integration
MONGODB_URI=mongodb://127.0.0.1:27019/gramatikapp npm run test:study-curriculum-simulation
MONGODB_URI=mongodb://127.0.0.1:27019/gramatikapp npm run audit:study-curriculum-performance
node scripts/renderStudyLevelAudit.mjs
npm run test:loading
npm run test:catalog-cache
npm run test:study-sync-validation
npm run build
```

Simulation/benchmark require the private snapshot created by `audit:study-curriculum-snapshot`, which reads the designated owner only; no credential is passed on the command line. Browser tests additionally require local Vite on 5173 and `scripts/studyCurriculumBrowserServer.ts` on 4000 with its explicit disposable database and local JWT secret. The browser fixture bootstrap expects an empty fixture database. The test scripts reject a non-loopback Mongo URI and drop only their owned unique databases.

All changes remain **local and unreleased**. No push, deployment, mobile release, production interval rewrite or inventory-count refresh was performed.
