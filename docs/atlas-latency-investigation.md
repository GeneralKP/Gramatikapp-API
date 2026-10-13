# Atlas connection and query-cost investigation — 13 October 2026

## Finding

The dominant measured delay is transferring large database requests and replies over a slow Atlas connection. Continuous catalog refreshes are the largest recurring source of traffic. The cluster is Free/M0 in AWS Northern Virginia (`us-east-1`), and its sampled seven-day outbound network history is approximately **110 GB**, far above the documented **10 GB per rolling seven days** allowance. Transfer throttling is strongly supported by the measurements and documented behavior, although Atlas exposes no definitive limiter-status flag in the available UI.

The current schema does not need to be changed to address the first causes identified here. Region distance contributes about **97 ms per round trip**, but does not explain multi-second transfers by itself. The API VPS showed low load, approximately 178 MiB service memory and ample available host memory; resource exhaustion was not observed in this snapshot.

MongoDB documents network throttling and a per-connection cooldown after M0 transfer limits are exceeded. The limit applies to the cluster, shared by its databases, rather than separately to this app. [Free-cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/).

## Scope and measurement boundaries

- Inspected the signed-in Atlas UI: Cluster0, Free tier, AWS N. Virginia, MongoDB 8.0.34. Storage was only about 46.6 MB of the 512 MB allowance; storage capacity is a different constraint from transferred bytes.
- Ran read-only audits **on the API VPS**, importing the running release's compiled modules, revision `0de804bd8a8b47a36b47c2ed65c7230eb0e7b9ae`. No production process was restarted or reconfigured.
- Used an existing large account with 4,705 progress records for direct database reads. The Writing fallback probe used the designated existing test account. No users, progress, reviews, exercises or AI requests were created.
- Index initialization was suppressed in the isolated audit process. Collection mutation methods and aggregation write stages were blocked. These guards affected only the audit process, not the running API.
- Timings below cover database reads/helpers from the VPS, including transfer and client processing. They are not whole-screen or physical-phone timings. Reply sizes are BSON database replies, before HTTP compression and final API field selection.
- The initial manual dashboard fallback probe projected a full scheduler and was broader than production. Its 3.21-second / 268.6 KB receipt is retained as a diagnostic only. The final ranking uses a separate read through the deployed `summarizedStudyCounts` helper and its actual projection instead.
- `explain('executionStats')` is a separate execution and excludes sending results to the client. Its timing is evidence of server work, not an exact subtraction from a preceding request. [Explain semantics](https://www.mongodb.com/docs/manual/reference/explain-results/).
- Unrelated working-tree changes were preserved. Application behavior, database structure, indexes, deployment settings and the canonical database diagram were not changed.

## Connection evidence

Three VPS-to-Atlas pings measured **101 / 97 / 97 ms**. Establishing a fresh application connection took about one second; the running application reuses its connection, so that is not a per-query cost.

A controlled probe repeated the same indexed, one-row read with the same 236-byte reply. Only a harmless command comment changed the request size:

| Request BSON bytes | Elapsed | Returned rows |
| ---: | ---: | ---: |
| 288 | 113 ms | 1 |
| 100,288 | 1,290 ms | 1 |
| 250,288 | 2,989 ms | 1 |
| 288, repeated afterwards | 102 ms | 1 |

This isolates request-transfer cost from result volume, query cardinality and regional round-trip latency. Local CPU for the largest probe was only 21 ms. Large replies likewise transferred at roughly 85–95 KB/s per measured read.

The dashboard count query is a concrete example: the WORD eligibility predicate includes thousands of catalog IDs in repeated `$in` lists. It sent **224,098 bytes**, returned **250 bytes**, and took **2,765 ms**. A separate explain reported **55 ms** server execution. A small response therefore does not mean a cheap request.

Source: [eligibility predicate](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/progress/studySummaries.ts:66>), [count summary](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/progress/studyLoading.ts:55>).

## Atlas network history

Read the metric responses used by Atlas's own Network charts for **6 October 21:13 UTC through 13 October 21:13 UTC**, at hourly granularity. Summing sampled `bytes out` rates across the three members gives approximately **110.3 GB**. This is an estimate from sampled physical transfer rates, not Atlas's internal quota ledger; node roles changed during the window and some samples were missing.

The current primary's recent outbound rate was about **179 KB/s** throughout several successive hourly samples. Integrating available samples over the final 24-hour window estimates about **15.2 GB**, with approximately 23.1 hours of sampled coverage. This predates most of the short investigation probes and shows sustained background traffic.

Atlas's Operation Throttling chart contained null series here. That chart describes rejected/killed operations and does not provide confirmation or disproof of weekly-byte transfer throttling. The available network history, M0 configuration, controlled transfer probe and published limits strongly support the transfer-throttling diagnosis. Exact limiter status would require MongoDB-side confirmation; no support message was sent.

Metric semantics and administrative alternatives are documented in the [reference notes](atlas-latency-reference-notes.md). [Atlas monitoring](https://www.mongodb.com/docs/atlas/review-all-cluster-metrics/).

## Catalog refresh: the largest continuous load

The running API reads all seven shared catalog parts before accepting HTTP requests, then attempts another refresh every **15 seconds**, including when no user is active. Concurrent callers share in-flight reads; a part still refreshing is not fetched twice. A cold warm-up took **26,623 ms**, a forced refresh cycle took **25,557 ms**, and an immediate cache hit took **0 ms with no database traffic**.

One cycle returned **22,245 documents / 4,620,773 BSON reply bytes**:

| Catalog part | Rows read | Reply bytes | Sum of its database-command times |
| --- | ---: | ---: | ---: |
| German word text, forms, notes and examples — `WORDS_DE` | 6,862 | 2,389,694 | 25,376 ms |
| Spanish word text, metadata and examples — `WORDS_ES` | 7,215 | 1,474,251 | 16,043 ms |
| Word relation identities — `WORDS_ES_DE` | 6,242 | 435,139 | 5,033 ms |
| German phrase text and linked word IDs — `PHRASES_DE` | 269 | 187,759 | 2,259 ms |
| Spanish phrase text/metadata — `PHRASES_ES` | 269 | 59,372 | 884 ms |
| Ready German grammar surfaces — `TRANSLATIONS_ES_DE` | 1,119 | 55,897 | 852 ms |
| Phrase relation identities — `PHRASES_ES_DE` | 269 | 18,661 | 381 ms |

These operations overlap, so their individual command times must not be added to estimate cycle wall time. The German word scan's explain reported **8 ms server execution**: its 25-second read is overwhelmingly transfer cost, not an expensive join.

At a perfect 15-second cadence, 4.62 MB/cycle would amount to approximately **186 GB/week** per process. Actual traffic is lower because slow parts remain in flight across timer ticks. Using the observed slow-part durations and single-flight behavior gives roughly 179 KB/s of sustained refresh traffic, close to the recent primary's observed network rate. This agreement supports catalog refresh as the dominant current background producer; the historical network totals also include other clients and databases on the cluster.

The cache's hard TTL is **30 seconds**. If a replacement is still in flight after expiry, callers await it. Cold startup definitely waits for these reads; an individual request's share of refresh waiting requires a request trace and was not assumed from the timer alone.

Sources: [startup warm-up](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/index.ts:36>), [refresh timer](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/progress/studyLoading.ts:154>), [catalog projections](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/progress/studyTextCatalog.ts:7>), [cache expiry and deduplication](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/progress/catalogSummaryCache.ts:6>).

## Most expensive measured reads and why

| Query/helper | Measured elapsed | Database reply bytes | Concrete load |
| --- | ---: | ---: | --- |
| German word catalog refresh | 25.4 s of database commands | 2.39 MB | Unfiltered catalog scan returning notes, examples and forms for 6,862 words, repeatedly. Server execution was only 8 ms. |
| Writing difficult words, C2, requested limit 6 | 23.92 s | 2.20 MB | Reads 4,163 eligible progress rows, groups 2,097 relations, joins three collections and returns 2,095 rich vocabulary rows. JavaScript then keeps six. |
| Writing automatic selection, C2 | 23.78 s | 2.20 MB | Same broad vocabulary read, despite selecting only four words. |
| Spanish word catalog refresh | 16.0 s of database commands | 1.47 MB | Fetches all 7,215 words including examples every refresh. |
| Unscoped `allProgress`, summary projection | 15.12 s | 1.43 MB | Transfers all 4,705 progress records. Current dictionaries use scoped reads instead; this is an expensive supported API path, not their current page-progress request. |
| Writing fallback for the test account, A1 | 11.41 s | 0.96 MB | Transfers 987 fallback vocabulary rows to choose two. There is no database limit for that selection. |
| Mixed practice candidate read | 11.25 s | 1.04 MB | Fetches 1,013 scheduling candidates before final selection. Repeated `scheduler.options` account for approximately 453 KB, 43% of the result BSON. |
| Word practice candidate read | 9.16 s | 0.85 MB | Fetches 766 candidate schedules; MongoDB examines 4,705 owner records. Server execution was 24 ms, so narrowing this scan alone would leave most current transfer delay. |
| Writing difficult words, A1, requested limit 6 | 5.84 s | 0.47 MB | Returns 486 qualifying vocabulary rows before keeping six. Cost increases with vocabulary level and account coverage. |
| Dashboard fallback scheduling states, deployed projection | 2.17 s | 0.18 MB | Transfers 273 states with selected scheduler fields for JavaScript compatibility/new-card handling alongside the database-side known-state summary. |
| Dashboard known-state count | 2.77–2.86 s | 250 bytes | The request itself is approximately 224 KB of catalog-ID predicates. Separate server execution was 55–58 ms. |
| Reading latest completed session | 2.58 s | 0.21 MB | Fetches a 101-event batch containing full before/after scheduler snapshots even though session discovery uses only a few fields. The cursor can continue into older history. |
| Phrase practice candidate read | 2.39 s | 0.20 MB | Reads 247 candidate schedules; 4 ms server execution. |
| Dashboard graduated identities | 2.05 s | 0.16 MB | Groups all 4,705 records and returns thousands of relation identities for application-side totals/path calculations. Server execution was 48 ms. |
| New-card allocation identities | 1.66 s | 0.12 MB | Groups all owner records to exclude already introduced relations. Returns 2,499 identities. Server execution was 18 ms. |
| Dictionary first word page, 61 rows | 1.36 s | 0.09 MB | Two joins and computed German sort happen before pagination across 6,242 relations. Explain examined 18,726 documents and 12,484 index keys; server execution was 280 ms. |
| Dictionary first phrase page, 61 rows | 1.00 s | 0.07 MB | Same join-before-sort shape on a much smaller catalog. Server execution was 13 ms. |

Writing's C2 explain reported **476 ms** server execution, three indexed content joins of about 2,095 rows each and approximately **6 MB sorted in memory**. Those are real computation costs, but most of the measured 24 seconds was waiting for 2.2 MB of results. Its `getMore` alone transferred about 2.09 MB in 21.8 seconds.

The deployed dashboard count-snapshot helper took **2,876 ms** overall. Its actual fallback read returned **175,471 bytes** in **2,168 ms**, while the parallel known-state aggregate sent 224,098 bytes and took 2,757 ms. These parallel reads must not be added together as the helper's elapsed time.

Scoped dictionary progress was much cheaper: **0.25–0.30 seconds**, 60 rows, **12.5–17.3 KB**, and **2–3 ms** server execution. This demonstrates that bounded indexed reads work under the same connection and normalized model.

Sources: [Writing aggregation and post-read slicing](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/writing/vocabulary.ts:35>), [practice candidate filter](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/progress/studyCandidates.ts:34>), [candidate projection](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/progress/studyTransport.ts:22>), [unscoped/scoped progress](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/progress/progress.resolvers.ts:414>), [Reading event cursor](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/reading/reading.service.ts:15>), [dictionary aggregation](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/src/features/levels/catalogQuery.ts:19>).

## Heavy server work and conditional query amplification

The import diagnostic **`wordsWithoutTranslation(lang: "DE", limit: 100)`** is the most expensive measured operation *inside MongoDB*: **1,254 ms server execution** and approximately **2,996,640 document examinations**. The anti-join uses `WORDS_ES_DE.translated`, but that collection has only its `_id` index. The engine repeatedly scans the relation collection while searching for untranslated words. This is an explicit import-tool query, not a dashboard/practice startup cause.

`wordRelationsWithoutPhrases(limit: 20)` likewise lacks indexes on the joined phrase `words` fields, but with the present small phrase catalog its explain took only **58 ms**. It examined approximately 25,920 documents in the initial stage and another 5,649 phrase documents in a later lookup. A missing index is a scaling risk; it is not automatically the largest current delay.

`mostFailedWords(limit: 10)` took **592 ms / 36.7 KB** for its initial aggregation. It groups full progress documents with `$push: "$$ROOT"` before limiting, then resolving the complete result adds up to three content reads per selected relation. The initial aggregate is not currently a top latency offender, but its memory use and query amplification grow with account size and requested limit.

Two conditional nested resolvers deserve attention when callers request them:

- `Word.failureIndex` performs a relation query plus a progress aggregation for every resolved word. Requesting it on both sides of 61 bilingual relations can add up to **244 database commands**.
- `NewPhrase.words` performs sequential word lookups, trying Spanish and then German when needed. A German phrase containing 12 words can cause up to **24 sequential reads**, adding roughly 2.3 seconds of round-trip latency before payload transfer.

Current dictionary requests omit these nested fields. They are not being blamed for current dictionary startup. Sources and deployed-version comparison are in the [reference notes](atlas-latency-reference-notes.md).

## Recommended order of work

1. Replace unconditional full-catalog refreshes with a bounded freshness mechanism: reuse unchanged generations, invalidate known writes, and detect external changes without repeatedly retransmitting all catalog text. Preserve external-import visibility and retry/expiry correctness.
2. Reduce large database request/reply payloads: catalog-ID count predicates, unbounded Writing selection, broad candidate scheduling reads and Reading event snapshots. Preserve exact scheduler eligibility, quotas, ordering, legacy compatibility, user edits and web/mobile parity.
3. Re-measure at the same seams. Reducing traffic does not necessarily clear an already-exceeded rolling-week quota immediately. A production upgrade/region move is a separate owner-controlled action.
4. Verify database/API geographic placement and assess the appropriate Atlas tier after removing waste. Region changes reduce the 97 ms baseline; tier capacity addresses shared-service limits. Neither makes unnecessarily large reads efficient.
5. Add the missing foreign-field indexes for import diagnostics after checking semantics and measured plans. This addresses genuine server work but is lower priority for the reported startup symptoms.

No changes in this list were implemented or deployed by this investigation.

## Reproducible evidence

Credential-free audit scripts and numeric receipts are saved locally:

- [.local/atlas-latency-audit.mjs](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/.local/atlas-latency-audit.mjs>) and [main audit measurements](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/.local/atlas-latency-audit.ndjson>).
- [.local/atlas-latency-probes.mjs](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/.local/atlas-latency-probes.mjs>) and [controlled probe measurements](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/.local/atlas-latency-probes.ndjson>).
- [Deployed dashboard-summary probe](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/.local/atlas-deployed-summary-probe.mjs>) and [its exact-projection measurements](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/.local/atlas-deployed-summary-probe.ndjson>).
- [Sanitized Atlas network series](</Users/kevin/Desktop/kev/German Gramatic/german-gramatic-api/.local/atlas-network-metrics.json>).

The scripts expect credential input through stdin and import modules from the deployed release directory. Receipts contain counts, sizes, timing, field names and plans; they do not contain account IDs, emails, record contents, passwords or connection strings.
