# Latency optimization — preparation and verification

The starting measurements are in [the Atlas investigation](atlas-latency-investigation.md). This log distinguishes local prepared changes, isolated live read probes and deployed behavior. It does not claim completed delivery before the final checks.

## Catalog freshness · 14 October 2026 · prepared, unreleased

The existing seven shared catalog projections now have one descriptor table. Snapshot reads return hashes beside their actual projected rows; exact BigInt sums bind the baseline to those rows. Compact checks use the same projection, type normalization and two salted hashes, with exact Decimal128 sums. No field, collection, index or per-user cache is added.

An unchanged check preserves the same immutable arrays and grammar index. Only changed parts reload. The existing 15-second timer and 30-second hard deadline remain; successful checks advance freshness, failures do not. Fresh requests remain immediate during checks; expired requests await the shared validation/replacement. Writer invalidation and generation guards remain intact, including partial/uncertain writes and cleanup failures. The signatures are probabilistic fingerprints; no cross-part transactional snapshot is introduced.

The meaningful regression failed on unchanged snapshot identity before the fix and passed afterwards. Cache, real MongoDB 8 signatures, loading, scheduler and build checks pass. The real dashboard 4,000-card fixture and dictionary/reviewed-content parity checks also pass. Independent code/spec review found no issues. The canonical diagram was updated and rendered independently at desktop and narrow widths; historical inventory dates/counts remain unchanged.

Web baseline types/build and loading/auth/synchronization/progressive/dictionary checks pass. Native types/lint, both Hermes exports and 99 tests in 12 focused suites pass. Current-source iOS and Android runtime passed the selected catalog/progress loading and failure recovery, search/CEFR/pagination, practice, rating/Undo, exact lost-ACK retries, cold offline restoration and account-switching checks. Android continuation audited 46 sanitized requests, including page-two progress scope and exact persisted retries, with no old-owner sync while the second isolated account was active. Both served source maps matched current source and loopback origins; no production state was used. The historical QA native shells ran current JavaScript; these checks do not claim a fresh native build, physical-device validation or native production timing. Owned runtime services/emulator were stopped without clearing app data. Expo Doctor reports an existing six-package patch lag (20/21), unrelated to this API-only change.

### Read-only Atlas proof

An isolated process on the API VPS used the compiled new signature source against the existing production catalogs. It blocked mutation methods/aggregation write stages and did not restart/reconfigure the API, initialize indexes, fetch account state or create test data. Credentials arrived through stdin and were not saved or emitted. This proves the operators and transfer reduction on Atlas; it does not deploy the new cache lifecycle.

| Part | Catalog rows | Check ms | Request BSON bytes | Reply BSON bytes |
|---|---:|---:|---:|---:|
| Word relations | 6,242 | 283 | 7,234 | 307 |
| Phrase relations | 269 | 186 | 7,236 | 307 |
| Spanish word text/metadata | 7,215 | 377 | 7,254 | 305 |
| Spanish phrase text/metadata | 269 | 182 | 7,244 | 303 |
| German word text/forms/feedback | 6,862 | 506 | 7,355 | 302 |
| German phrase text/references | 269 | 188 | 7,259 | 304 |
| READY German grammar surfaces | 1,119 | 191 | 7,302 | 314 |

Each part used one aggregation and returned one signature. Total reply size is **2,142 bytes**, compared with the original **4,620,773 bytes** per full refresh: approximately **99.95% less reply data** on an unchanged cycle. Requests total 50,884 bytes because the normalization expressions travel in the aggregation commands. The checks still scan/hash projected content inside MongoDB. The rows above ran sequentially for measurement; the application retains parallel checks. These are VPS database-helper timings, not whole-screen or physical-phone timings.

Local fixtures independently exercise all projected changes, inserts/deletions, ignored fields, filter membership, ObjectIds, missing/null, fractional numeric types, arrays/forms, checksum precision, actual grammar-index identity and cache race/failure boundaries. The fixture enforces a unique dedicated loopback database before any connection/drop and rejects credentialed or unsafe targets.

Credential-free scripts/receipts remain under `.local/catalog-signature-live-probe.*`. The production service remains on its original release until the authorized delivery stage. Already-exceeded rolling Atlas transfer limits may take time to clear after traffic is reduced; the investigation's throttling diagnosis remains an inference supported by measurements and published limits.

## Exercise payloads · 14 October 2026 · prepared, unreleased

Writing sorts grouped progress before rich joins and stops after the requested usable reviewed words. Recent selection ranks a minimal first-180-usable pool, retaining its first-read scores, then hydrates only the selected words. Fallback ranks minimal usable labels/IDs and revalidates rich winners, filling from remaining ranks after an intervening unavailable edit. Reading projects session discovery to four fields and returns only latest-per-page attempts plus any-READY visibility. Public content, order/seed, CEFR, failures/credits, reference visibility, ownership and persistence contracts remain unchanged.

The first fixture reproduced the original bulk payloads. A second regression caught 108 tiny RECENT cursor batches despite a byte reduction; the final selection uses six reads on the same rejected-prefix fixture. Complete old/new public outputs, first-read scores and edit recovery match. The existing full Reading mock-provider and Writing vocabulary workflows pass after these changes; independent task review is tracked in the plan ledger. These figures are isolated MongoDB fixture traffic (requests, replies and cursor closes), not live screen timings:

| Path | Before bytes | After bytes | Reduction | Final read batches |
|---|---:|---:|---:|---:|
| Difficult six | 3,580,970 | 10,346 | 99.71% | 1 |
| Recent first-180-usable pool/winners | 3,580,949 | 97,137 | 97.29% | 6 |
| Seeded fallback | 3,607,549 | 267,057 | 92.60% | 4 |
| Reading discovery, full tested history | 3,110,841 | 62,564 | 97.99% | 7 |
| Latest displayed attempts/READY visibility | 917,698 | 7,948 | 99.13% | 1 |

Reading's first discovery batch is 8,750 bytes. Early-return cursors are closed. Minimal discovery and rich hydration have separate observation points; hydration revalidates/refills rather than claiming a transaction. No catalog field pruning or schema change accompanies this stage.

### Read-only exercise proof on Atlas

An isolated VPS process compared complete outputs of the deployed helpers and the reviewed new helpers, without changing the running API. Collection mutations and aggregation writes were blocked; index initialization was suppressed. It used existing records only, with the designated existing test account for the fallback case. No users, progress, reviews, exercises or AI requests were created. All four complete outputs matched exactly.

| Helper | Before ms | After ms | Before reply bytes | After reply bytes |
|---|---:|---:|---:|---:|
| Writing C2 difficult six | 23,995 | 325 | 2,204,499 | 7,386 |
| Writing C2 recent four | 23,970 | 902 | 2,204,499 | 37,634 |
| Test-account A1 fallback | 11,511 | 2,597 | 956,085 | 91,454 |
| Reading latest completed session | 2,575 | 292 | 206,022 | 8,809 |

These are real VPS-to-Atlas helper timings with the same parameters, not deployed whole-screen results. The fallback still scans minimal eligible labels to preserve the existing seeded ranking; it remains slower than the bounded practiced-word path on the currently slow connection. Credentials were transient stdin only; numeric receipts/scripts are under `.local/exercise-query-live-probe.*`. A first isolated bootstrap failed module resolution before any query probe; the dependency path was corrected for the successful comparison. The running release remained unchanged.

## Remaining stages

The reviewed Writing/Reading selection, account summaries and practice-option transport are prepared. Import anti-join indexes and final delivery/live verification are tracked in [the implementation plan](superpowers/plans/2026-10-13-latency-optimization.md). No paid Atlas tier or region change has been made.

## Connection compression experiment — 14 October

A read-only isolated VPS process compared the same 1,000 German catalog rows with no compressors and requested zlib. The current Atlas connection negotiated `none` for both. Outputs were identical; decoded BSON was449,225bytes and measured socket reply449,443bytes in both cases. Wall time was5,126ms vs5,143ms. This connection did not provide a zlib benefit; no application connection setting, Atlas tier or production state changed. Credential-free script/receipt: `.local/atlas-compression-probe.mjs/.ndjson`. Official connection option reference: [MongoDB Node network compression](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/network-compression/).

## Compact account reads — prepared, independently reviewed, unreleased

The original counter/classification predicates are preserved against the request’s existing catalog generation. Fresh known counters pack raw identities/count flags; mastery and allocation pack identity arrays. Legacy compatibility retains each checkout’s existing projection and scheduling feature behavior. A review found two malformed-reference gaps; both were corrected and independently re-reviewed: null-containing relation arrays retain the original itemId catalog fallback, and scalar ObjectIds match only direct array elements. Sixteen isolated array cases across six category scopes, the full loading suite and curriculum integration pass. No collection fields, owner caches or live account data were changed.

Read-only actual Atlas comparison from an isolated VPS process; counts use the same word/phrase catalog scopes as the deployed app, fixed time per pair, and complete outputs agree:

| Read | Before ms | After ms | Before request / reply bytes | After request / reply bytes | Full output |
| --- | ---: | ---: | ---: | ---: | --- |
| Word known count | 2,780 | 228 | 224,098 / 250 | 2,269 / 7,840 | identical |
| Phrase known count | 227 | 128 | 10,534 / 250 | 2,271 / 644 | identical |
| Mixed known count | 2,767 | 251 | 233,005 / 250 | 2,250 / 8,273 | identical |
| Mastery identities | 2,092 | 785 | 1,185 / 159,468 | 1,197 / 50,024 | identical |
| Allocation identities | 1,688 | 567 | 493 / 124,589 | 490 / 43,778 | identical |

All compared operations remained one database command each. These are query-seam samples, not complete screen timings. During these measurements the production API remained0de804b; there was no restart, index creation, owner write or AI generation. The first comparator retained both catalog types for each known scope to verify generation handling; the final counter receipt uses the app’s exact type scopes, avoiding inflated phrase-query baseline traffic. Numeric-only receipts: `.local/account-summary-live-probe.ndjson` and the mastery/allocation rows in `.local/account-summary-live-probe-common-catalog.ndjson`; remote probe modules were removed afterward.

A subsequent read-only `hello` capability probe requested snappy, zstd and zlib; this current Atlas endpoint advertised none of them. No driver compressor or dependency was added. Numeric receipt `.local/atlas-compressor-capabilities.ndjson`; remote script removed. This describes the tested connection, not a claim about every Atlas tier.

## Repeated practice options — prepared, independently reviewed, unreleased
Projected candidate/state reads send complete ordinary scheduler options once per distinct group, with typed BSON primary-ID memberships. Reconstruction preserves complete per-card state, exact input order and independent mutable options before scheduling. Custom/nonstandard BSON values remain inline; identified aggregate size/memory limits fall back to the original read. No stored property is pruned or normalized away. Independent review caught an ObjectId/string primary-key collision; the BSON identity fix and regression passed scoped re-review.
The final helper was compared read-only against the deployed find on Atlas. Full state and input order matched for every row, with one database read in each case:
| Scope | Rows | Before ms | After ms | Before reply bytes | After reply bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| mixed | 1,014 | 11,318 | 6,947 | 1,044,407 | 613,615 |
| WORD | 767 | 9,166 | 5,880 | 848,003 | 514,391 |
| PHRASE | 247 | 2,385 | 1,339 | 196,491 | 99,727 |

The mixed read still took **6.95 seconds** on the existing M0 connection. Packing reduces transfer, but does not establish acceptable final practice latency. The catalog fix has not yet been deployed, and the rolling transfer restriction remains a supported inference. Postdeployment measurements will determine the residual cost. Numeric receipt: `.local/candidate-packing-live-probe.ndjson`; all remote modules were removed. No owner state, index or running release changed during this comparison.

## Live web baseline — existing test account, before delivery
A fresh incognito browser exercised only the existing dashboard and dictionaries on the deployed preview and API. It allowed Me, DashboardStats, DictionaryWords, DictionaryPhrases, AllProgress and the read-only card-edit endpoint; write-capable operations were blocked. All nine observed requests returned HTTP 200 with no GraphQL errors, and both dictionaries showed 60 entries. No practice entry, review, exercise generation, registration or edit was performed. Passwords/tokens were transient only.
| Screen | Visible content ms | Scoped study status ms | Main GraphQL ms |
| --- | ---: | ---: | ---: |
| dashboard | 4,576 | included | 3,396 |
| words | 2,476 | 2,485 | 1,618 |
| phrases | 1,266 | 1,499 | 1,155 |

These single-run screen samples include browser/static loading, API work, network and rendering. They are distinct from database-helper timings. The same strict harness is saved for the after-delivery run. Numeric receipt/screenshots: `/tmp/latency-live-web-20261014/before.*`; the initial run without the explicit scoped-status wait is retained separately as `before-initial.*`.

## Catalog anti-joins — prepared, independently reviewed, unreleased

Four additive nonunique indexes support WORDS_ES_DE.main/translated and PHRASES_ES/PHRASES_DE.words. The existing foreign equality lookups now project only an identity and stop at one match. Result limits remain after absence filtering, and selected relations retain full bilingual hydration. No collection/owner fields or user state change.

The guarded MongoDB 8 fixture freezes the original resolver queries and compares complete ordered ES/DE results, duplicate/missing/null/typed-array references, phrase arrays and limits omitted/0/1/20/100. Its duplicate-rich foreign collections exceed the small-table SBE hash-join threshold, exposing the repeated scans:

| Operation | Before foreign documents examined | After | Indexes used after | Reply bytes before / after |
| --- | ---: | ---: | --- | ---: |
| words-ES | 6,912,000 | 200 | catalog_anti_join_main | 96,201 / 96,201 |
| words-DE | 6,912,000 | 200 | catalog_anti_join_translated | 96,201 / 96,201 |
| relations | 9,792,000 | 200 | catalog_anti_join_words, _id_ | 47,404 / 47,404 |

Across the fixture's three reads, foreign examination falls from **23,616,000 to 600**, with zero foreign collection scans after indexing. These are isolated explain/traffic results, not production wall-time claims. The unchanged reply sizes show a server-work optimization, separate from the transfer reductions above. Live indexes will be created only during the authorized API delivery.

## Complete release verification — 14 October, before delivery

A detached checkout based on deployed0de804b contains only the performance work. The original dirty API/web/native work remains intact. Required deployed-backend CI gates plus the new real-Mongo differential fixtures, full Reading mock-provider/Writing vocabulary workflows and curriculum integration passed across 34 verification steps. The first run passed33/34; its phrase-grammar fixture still counted find rather than the new snapshot aggregate. A fresh integration worker corrected only instrumentation, retained real HTTP/Mongo content and progress assertions, and passed the covering integration and explicit test TypeScript check in both checkouts. The initial failed receipt is retained; it is not rewritten as an initial pass.

Web types/build and selected behavior suites passed. Current-source iOS/Android QA runtimes passed the selected loading, retries, pagination, practice, ratings/Undo, offline/cold recovery and owner-isolation checks. Native historical-shell/physical-device/production-timing limits remain as above. Deployment/readiness/rollback helper tests also passed. Final whole-package review and live delivery verification remain pending. No paid tier/region change or collection-property pruning has been made.

## Delivered API and live results — 14 October 2026

[PR #6](https://github.com/GeneralKP/Gramatikapp-API/pull/6) was merged and [the main verification/deployment workflow](https://github.com/GeneralKP/Gramatikapp-API/actions/runs/38488173598) passed. Public health confirms exact revision **963baf4fa9f0d4d25259a95924897fb8dfbf3c7d**. Four named foreign indexes are present on Atlas. The original API/web/native working changes are preserved separately; this delivery contains the reviewed performance package. The final test cleanup and external-CI memory-code assertion adapters also passed focused reviews. Production code handles both 146 and 4031700; CI now accepts the real memory-error variants while preserving complete fallback state/order checks.

A sequential, read-only VPS process imported the actual new release and guarded collection mutations, aggregation writes and index initialization. Existing-account helper results:

| Helper | Deployed ms | Reply bytes | Result rows |
| --- | ---: | ---: | ---: |
| difficult-c2-six | 333 | 7,386 | 6 |
| recent-c2-four | 1,008 | 37,634 | 4 |
| tester-fallback-a1 | 2,599 | 91,454 | 2 |
| reading-session | 296 | 8,809 | 1 |
| candidates-mixed | 6,977 | 613,615 | 1,014 |
| candidates-WORD | 5,886 | 514,391 | 767 |
| candidates-PHRASE | 1,354 | 99,727 | 247 |
| wordsWithoutTranslation-ES | 828 | 49,390 | 100 |
| wordsWithoutTranslation-DE | 953 | 61,993 | 100 |
| wordRelationsWithoutPhrases | 510 | 38,920 | 20 |

The seven deployed signature reads return 2,142 bytes total, matching the isolated preparation proof. Remote benchmark source was removed after completion; credentials were transient stdin only. Numeric receipt: `.local/atlas-after-audit.ndjson`. No users, reviews, progress, exercises or AI calls were created.

### Live web, same existing test account and harness

| Screen | Before main GraphQL ms | After | Before data/content DOM ms | After |
| --- | ---: | ---: | ---: | ---: |
| dashboard | 3,396 | 670 | 4,576 | 1,551 |
| words | 1,618 | 1,642 | 2,476 | 2,486 |
| phrases | 1,155 | 1,177 | 1,266 | 1,251 |

Both dictionary pages contain 60 visible entries. All nine after requests returned HTTP 200 with zero GraphQL errors, with the same decoded response byte counts. Word study status completed at 2,500 ms and phrase status at 1,529 ms. The dashboard DOM metric is data-loaded layout creation; its existing Framer Motion overview/child animations were still running in the immediate before/after screenshots, so it is not a full-animation or LCP measurement. All three saved after screenshots were inspected; dictionaries show content and loaded statuses. Numeric/screenshots: `/tmp/latency-live-web-20261014/after.*`. The allowlist continued to block write-capable operations; none was requested.

### Actual recurring API traffic

Unprivileged Linux socket telemetry selected only the dedicated gramatik-api service UID and MongoDB TCP sockets, excluding the VPS’s other applications. Each observation pair retained an identical socket set within its own window. These are short traffic samples, including TLS/heartbeats; they are not the Atlas quota ledger.

| Sample | Duration sec | Stable sockets | Received bytes/sec | Sent bytes/sec |
| --- | ---: | ---: | ---: | ---: |
| Original API | 48.073 | 18 | 198,440.64 | 262.41 |
| Delivered API | 38.320 | 13 | 828.06 | 4,040.31 |

Received rate falls **99.583%**, from 198.4 KB/s to 0.83 KB/s. The after sample sends 154,824 bytes across 38.32 seconds, consistent with three compact 51 KB signature cycles plus connection maintenance. Incoming traffic includes the compact replies and heartbeats. This directly verifies that the running API stopped the old recurring bulk transfer.

### Remaining performance limit and proposed next step

The current cluster remains Free/M0 in AWS N. Virginia. Mixed candidates still transfer 613,615 bytes in 6.977 seconds; Word candidates 514,391 bytes in 5.886 seconds. Dictionary query timings are essentially unchanged. Reducing traffic does not immediately erase a previously exceeded rolling seven-day transfer allowance. The network-limit diagnosis remains strongly supported, not an authoritative MongoDB limiter flag.

The measured VPS load was low, so a larger VPS is not the first justified change. Keep the shared master catalog and per-owner state; full copies for every registration would multiply data without resolving the current transfer restriction. Targeted dictionary sort/read-model work can be considered if its server work becomes dominant after the connection is healthy.

Atlas Flex includes unlimited transfer and currently costs **$8–$30 per 30 days**, usage based, with 5 GB storage. [Official Flex pricing](https://www.mongodb.com/docs/atlas/billing/atlas-flex-costs/). Switching from Free to Flex requires downtime and halting writes, followed by application restart. [Official cluster-scaling considerations](https://www.mongodb.com/docs/atlas/scale-cluster/). This infrastructure purchase has not been authorized or performed. A closer supported EU region is a subsequent option for the measured ~97 ms round-trip distance; a tier change must be measured before promising a latency target.

### Actual indexed server work and database isolation

A follow-up read-only process captured the deployed resolver pipelines and explained those exact pipelines on Atlas. It suppresses index initialization, blocks mutations, emits no query IDs/content, and removes its remote source afterward:

| Read | Foreign endpoint | Documents / keys examined | Foreign scans | Index | Server execution ms |
| --- | --- | ---: | ---: | --- | ---: |
| wordsWithoutTranslation-ES | WORDS_ES_DE.main | 145 / 145 | 0 | catalog_anti_join_main | 39 |
| wordsWithoutTranslation-DE | WORDS_ES_DE.translated | 233 / 233 | 0 | catalog_anti_join_translated | 38 |
| wordRelationsWithoutPhrases | PHRASES_ES.words | 12 / 12 | 0 | catalog_anti_join_words | 8 |
| wordRelationsWithoutPhrases | PHRASES_DE.words | 1 / 1 | 0 | catalog_anti_join_words | 8 |

The DE translation-gap foreign examination is now **233 documents**, versus the original **2,996,640**; server execution is **38 ms**, versus the earlier **1,254 ms** separate explain. The phrase-gap read uses both multikey indexes and retains the full selected endpoint hydration. These explain timings measure server work, separate from helper wall time and reply transfer. Receipt: `.local/catalog-antijoin-live-explain.ndjson`.

The same metadata-only probe requested complete database-name visibility and counted **eight other non-system databases** on this cluster; it did not emit their names or read their records. The proposed paid step is consequently **a separate Flex cluster for German Gramatik**, with only the existing gramatikapp data moved, a supported region near the VPS, preserved IDs/schema/authentication, and a controlled maintenance/cutover. It would isolate quota and performance while preserving the other databases. This purchase/migration remains pending the owner’s approval. Staying on M0 means quota recovery depends on total traffic across the shared cluster.

Completed verification fixtures and their owned anonymous Docker volumes were removed; the owned Mongo bridge and native QA runtime services/emulator were stopped. Existing app/simulator storage, unrelated containers/services and original unreleased work are preserved. Review evidence is archived locally under `.local/latency-review-archive-20261014`; the finished SDD plan workspace was removed after its reviewed fixes were merged.
