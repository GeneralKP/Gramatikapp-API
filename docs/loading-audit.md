# Dashboard, study and authentication loading audit

Measured on 6 October 2026 by executing the real GraphQL schema locally against the configured MongoDB database. The existing account selected for the audit had 4,624 study cards. No account identifiers or content are saved here. These are backend operation times, not deployed browser page-load measurements.

| Operation | Before | After, two runs |
| --- | ---: | ---: |
| Dashboard, first request | 4,355–5,237 ms | 2,333–2,911 ms |
| Dashboard, subsequent request | 2,949–3,146 ms | 1,544–1,784 ms |
| Words, 50 due cards plus learning ahead | 3,911–4,134 ms | 1,389–1,434 ms |
| Words, 722 returned cards | 21,572–21,795 ms | 2,234–2,817 ms |

The large word response remained exactly 2,320,237 bytes in these live runs. The smaller queue varies slightly as learning cards become due. The audit uses `newLimit: 0` so it measures existing-card loading without allocating native introductions. It does not measure creation of new native pairs or provider/AI work.

The dominant word-session bottleneck was the nested GraphQL resolver pattern: 722 relation reads and 720 reads in each language collection, or 2,162 catalog queries. Bulk hydration now performs three catalog reads for this word-only queue. Both word and phrase queues, shared vocabulary entries, missing relations and missing endpoints retain their original response behavior. This follows Apollo's guidance on [eliminating repeated nested data fetches](https://www.apollographql.com/docs/apollo-server/data/fetching-data).

The due-card MongoDB query already uses `userId_1_nextDueDate_1`. Its execution plan examined 4,624 documents, returned 967 candidates and took 16 ms. Adding an index was not justified by these measurements: most elapsed time was repeated round trips, transfer and response construction.

## Further phrase, mixed and authentication audit

These measurements compare the first optimization above with the additional request-sharing/category changes, in the same local environment on 6 October 2026. They isolate the second round; mixed practice already benefited from bulk relation loading in the first round.

| Operation | Before second round, one run | After second round, two runs | Response size |
| --- | ---: | ---: | ---: |
| Phrases, 28 returned cards | 1,050 ms | 746–838 ms | 70,568 bytes |
| Mixed, 750 returned cards | 2,575 ms | 2,675–2,768 ms | 2,390,791 bytes |
| Phrase category, empty queue | 719 ms | 431–488 ms | 15 bytes |
| Mixed category, 475 returned cards | 3,154 ms | 2,733–2,891 ms | 1,537,149 bytes |
| Authentication + complete `Me` | 359 ms | 212–213 ms | 284 bytes |

The additional mixed changes reduce query dependencies but did not improve the unfiltered mixed timings in these runs. Its 2.4 MB response remains the main observable cost after removing per-card catalog queries. This is an inference from payload size and fast selection plans, not a measured split between CPU, transfer and browser rendering. No deployed-browser latency claim is made.

The phrase selection plan uses `userId_1_itemType_1_failureIndex_-1`, examines 266 documents and takes 2 ms. Mixed selection uses `userId_1_nextDueDate_1`, examines 4,624 documents and takes 15–29 ms. Token account lookup uses `_id_`; email login lookup uses the existing unique `email_1`. Both examine one document and take 0–1 ms. Category scans examine 4,152 Spanish words in 3–4 ms and 269 Spanish phrases in 0 ms. New indexes, server-wide caches and an aggregation rewrite were not justified by these plans; account/profile reads remain fresh on every request.

`dueItems` and `studyMoreItems` now share the authenticated account and scheduler profile instead of rereading users/settings/profile in sequence. Independent category lookups run together and allocation reuses their result. Counts load only the requested relation catalog and omit unused metadata. When pending cards fill the request, allocation skips the full reviewed-ID exclusion query. Creating new progress uses a single batch of unique-key `$setOnInsert` upserts, followed by a persisted read. Repeat/concurrent allocations retain existing schedules; only duplicate-key conflicts are tolerated, and other write/acknowledgement failures propagate. Native recognition/production conversion retains its existing transaction path. These allocation changes are verified with mocks; the live audit blocks writes and does not time them. MongoDB documents the [bulk-write ordering and error behavior](https://www.mongodb.com/docs/drivers/node/current/crud/bulk-write/).

Authentication now fetches only account fields, excluding `passwordHash` from token validation. `Me`, authorized own-user aliases and settings reuse that account within a request, while login still fetches and checks the password hash. JWT validation explicitly accepts the application's HS256 tokens and checks payload types before a database read. Signature, expiry, not-before and deleted-account checks remain enforced. No user or token is cached across requests.

In the browser, cached account data requires a token and corrupt cached JSON no longer prevents startup/logout. Authentication validation uses its captured token, avoids Apollo query deduplication/cache writes, and discards responses after cancellation or a token change. Logout clears Apollo data without refetching authenticated queries. The browser tests cover late logout/account-switch responses, expired tokens, offline validation, missing tokens and corrupt caches. This preserves offline access while leaving API ownership validation authoritative. Apollo describes [cache clearing at authentication boundaries](https://www.apollographql.com/docs/react/networking/authentication).

Dashboard counts and the learning path now share one projected progress read and one catalog snapshot per GraphQL request. Independent reads run together. The projection preserves scheduler, legacy Anki, update-time, burial and directional prerequisite inputs, while excluding large card text and mistake-history payloads. Account state never persists between requests. MongoDB documents [field projection](https://www.mongodb.com/docs/drivers/node/current/crud/query/project/) as the mechanism for returning only the required fields.

The browser previously waited for `Me` before mounting the dashboard. A saved signed-in account now starts dashboard data loading while the API validates its token. Reading metadata, refresh listeners and polling run only on Reading routes. API authentication and ownership checks remain in force.

At that stage, no card prefetch was added. `dueItems` can create new progress and directional pairs, so speculative dashboard requests would introduce write behavior. Bulk loading removes the dominant delay while preserving the full 5,000-card request limit and existing local session behavior. The remaining large response is about 2.3 MB; transfer time on a slow connection still contributes to entry latency.

## Further dashboard and initial phrase entry optimization

The previous phrase audit used `newLimit: 0`, while the browser's initial phrase request uses the account allowance (20 for the audited account). The new read-only audit includes this real entry path and phrase counters. The account had enough pending introductions, so the default-entry audit performed no writes. All write and index-changing methods remain blocked; an account requiring allocation causes the audit to fail instead of saving anything.

Before/after runs were sequential on 6 October 2026, against the same configured database and 4,624-card account. “Before” uses API commit `ffcaf4d36239ae4cc7ceb12786d3d6ef8e94e5b7` in a temporary isolated snapshot with the same timing harness and dependencies. First-request timings include connection-pool expansion after connecting; repeated-request timings use the same process. These are local backend measurements, not production browser timings.

The user reported roughly three seconds on the production Cloudflare site before this round. Public API health confirmed the previous backend commit was live; authenticated public GraphQL timing could not be verified with the local credentials. The table therefore does not claim a measured reduction of that three-second browser experience.

| Operation | Before | After |
| --- | ---: | ---: |
| Dashboard, first request | 2,102 ms | 1,676 ms |
| Dashboard, settled repeated requests | 1,181–1,316 ms | 640–678 ms |
| Initial phrases, 20-new-card allowance, first request | 1,913 ms | 1,500 ms |
| Initial phrases, same allowance, repeated requests | 977–1,030 ms | 420–543 ms |
| Phrase counters, first request | 2,108 ms | 999 ms |
| Phrase counters, repeated requests | 1,389–1,423 ms | 410–458 ms |

The dashboard response remained 4,780 bytes, phrase entry returned the same 48 cards and 122,074-byte response, and phrase counters remained 81 bytes. The earlier large word/mixed queues retain their complete response contract and 5,000-card limit.

Command-level measurements exposed a hidden cost in the previous “projected” progress snapshot: full embedded scheduler options still made it 5,664,024 bytes of BSON across two batches. Phrase counters fetched that entire account snapshot, even though only 266 phrase progress records existed. Dashboard counters now fetch only due reviews, all new/learning/relearning cards and unscheduled legacy records of the requested type, projecting only counter/selection inputs. Its 973-row word scheduling read was 803,635 bytes, plus 413,577 bytes of compact relation/mastery identities shared with `learningPath`. Phrase counters read 251 relevant scheduling records and 266 catalog-matching identities: 127,311 bytes combined, about 98% less progress transfer. These are uncompressed BSON command-reply sizes, including the small cursor envelopes.

The identity read retains cross-type relation matches and the `itemId` fallback for absent or explicitly null `relationId`. It keeps learned totals for unavailable/future cards. NEW recognition prerequisites remain present when future, buried or suspended. All future minute learning is retained so customized learn-ahead periods still work; temporary due dates retain reviews with a future regular schedule. Per-card review ceilings, mixing settings, new-card construction steps and legacy Anki initialization inputs remain available. Counter-only scheduler projections are never serialized as study state or saved.

Daily allowance reads start while snapshots load. Due selection starts while scheduler metadata and daily counts load. Phrase allocation reuses the due query's complete pending set, including future new phrases; `newCardGroups` keeps the same ordering and quotas. Creation still uses the existing idempotent batch and native words keep their transaction path.

Summary/catalog reads use batches of 5,000 documents; rich queue/content reads use 1,000. These change only cursor transfer, with no result limit or `singleBatch` truncation. Dashboard database commands fell from 12 (five `getMore`) to eight (no `getMore`); phrase entry fell from eight to six; phrase counters fell from six to five. MongoDB explains the [default 101-document initial batch and extra-round-trip tradeoff](https://www.mongodb.com/docs/manual/reference/method/cursor.batchsize/). A batch-size-only experiment removed round trips but left most dashboard latency intact; narrowing transferred scheduling data was also necessary. An audit-only zlib experiment showed no useful timing gain, so no production compression setting was added.

Selection plans remain fast. Phrase scheduling uses the existing owner/type index, examines 266 documents and takes 2 ms; the catalog-matching identity query examines the owner's 4,624 documents and takes 16 ms using an existing owner-prefixed index. Its small projected result, rather than faster scanning, removes the measured cost. Adding more indexes would not address the dominant transfer/round-trip cost. No database schema, collection or index changed. First requests still incur connection-pool startup and network latency; the improvement is stronger on subsequent requests. Actual deployed browser timings remain unverified.

Repeat an operation with `AUDIT_FILTER=phrases-entry AUDIT_REPEAT=3 AUDIT_DETAILS=1 npm run audit:loading` (or `dashboard` / `phrases-counts`). The harness prints only aggregate sizes, command names, row counts, elapsed/CPU time and query-plan statistics; it never prints account identifiers or card contents.

## Regression coverage

`npm run test:loading` in the API runs the real GraphQL schema and resolvers against mocked MongoDB responses, without any database connection. Complete JSON response fixtures were captured from API commit `fb32c3ed2488feca5e15aaf2fcb6bf6f047cf443` before the optimization. The tests compare nested catalog fields, card directions, serialized scheduler state, review choices, counts, category selection, extra practice, null relations and GraphQL error shape. They also cover a single-place native allowance, buried recognition prerequisites, legacy scheduling, unavailable cards, absent profiles, account isolation and bounded bulk-query counts. Versioned client operations keep the suite independent of a neighboring frontend checkout. Fixture changes require an intentional contract review. API CI runs loading and authentication regressions before publishing a backend release.

Additional complete phrase/mixed response fixtures were captured immediately before the second round. Allocation tests assert exact new-phrase fields/content/dates, one batched write, idempotent repeats, category reuse, the pending-queue shortcut and propagation of non-duplicate/acknowledgement failures. Mixed hydration also covers overlapping word/phrase relation IDs, and zero-limit requests keep their original early-return behavior. `npm run test:auth` runs actual JWT/bcrypt and GraphQL resolvers against mocked users/profile responses. It checks rejected tokens before database access, deleted accounts, normalized email login, wrong credentials, seven-day tokens, complete auth response fields, explicit zero/default allowances, bounded reads and cross-account query rejection.

This round first reproduced the unrelated-word snapshot in a failing mocked phrase-counter assertion, then added scoped/projection checks. Additional real-schema cases cover future NEW recognition, future REVIEW recognition before new production, buried/suspended recognition prerequisites, custom per-card review ceilings, the authoritative account new-card allowance, custom minute learn-ahead at and one millisecond beyond its boundary, temporary reviews with future regular dates, legacy future introductions and cross-type identities with present/null/missing `relationId`. Held snapshot/profile reads prove allowance/selection work overlaps without timing thresholds or live connections. Existing complete response fixtures were not changed.

`npm run test:loading` in the web repository uses mocked GraphQL responses with an intentionally held authentication response. It verifies that dashboard data begins during validation, Words/Phrases/Mixed open with the same card shapes and full queue limit, requests keep their card-type scope, and these paths do not request Reading metadata. `npm run test:auth` covers the browser authentication scenarios above.

Existing learning, exercise-entry, study-sync and session-completion suites protect scheduling, Undo, durable mistakes, retry/recovery and explicit AI generation boundaries. `npm run audit:loading` repeats the guarded read-only timing and query-plan audit; it bypasses index creation and blocks database writes.

The canonical standalone database diagram records these changes. Its collection inventory and original inventory audit date are unchanged. These measurements come from a local read-only audit; no deployment or production data mutation is part of the measurements.

Both production builds and TypeScript checks passed. Web lint passed with generated `.wrangler/**` files excluded; the default lint command has an existing `no-empty` error in a generated Wrangler temporary worker. No generated file or unrelated lint configuration was changed.


## Progressive transport and static catalog cache, 6 October 2026

The signed-in Cloudflare production audit before this implementation cleared the HTTP and derivative study caches for every sample and bypassed the HTTP cache during hard reload. Dashboard took 1.18–2.09 s (nine samples, median 1.553 s), Phrases 1.036–1.142 s (three, median 1.115 s), Words 4.171–4.232 s (three, median 4.198 s), and Mixed 4.240–4.329 s (three, median 4.308 s). These measure reload-to-dashboard-ready and click-to-first-playable-card respectively. Words sent 751 complete cards and 2,655,682 bytes of JSON; Mixed sent 779 and 2,732,421 bytes. A separate three-run production A/B omitting server rating previews retained the same 751 cards and reduced the request median from 3,267 to 2,681 ms. Small query-plan execution times did not explain the full transfer/preparation cost.

The implementation introduces authenticated, no-store REST queue/cards/more responses alongside the compatible original GraphQL operations. Full canonical selection happens before slicing 24 complete starter cards (extending the boundary for new siblings). The initial manifest retains every selected schedule, sibling identity and German/Spanish text for ordering, counters, local burial and phrase distractors. Repeated deck options are shared and the authoritative fuzz seed is retained. Complete background batches of 100 contain all answers, Notes, Examples and required grammar before becoming playable. Reveal and Check never initiate a fetch. Route/account cancellation and version-aware merging protect the active answer and locally reviewed schedules. Local previews use the generated server scheduler only for the revealed card. Outbox projection/parsing happens once per batch and derivative cache writes are deferred until after rendering.

Six immutable static relation/context/text parts now warm before API startup and refresh atomically every 15 seconds, with strict 30-second expiry and invalidation on catalog writes/partial failure. There is no cross-request cache of accounts, authentication, progress, profiles, quotas or counts. This adds six static database reads (roughly 1 MB uncompressed BSON total) per refresh per API process; external catalog changes are visible within 30 seconds. Native counting loads short text/forms rather than full content. Cursor batching reduces extra round trips without truncating queues. No schema, indexes or physical data order changed. A MongoDB compression probe was removed: the configured deployment negotiated no compression and showed no benefit.

Guarded local API timing, startup-equivalent static warming, `newLimit: 0`, no allocations/writes:

| Operation | Repeated samples | Initial JSON |
| --- | --- | --- |
| Dashboard, existing account | 206–670 ms | 4,780 bytes, unchanged |
| Dashboard, empty account | 264–351 ms | Counts/shape preserved |
| Words, starter 24 | 932 / 828 / 772 ms | 555,836 bytes; 722 manifest cards |
| Phrases, starter 24 | 299 / 307 / 304 ms | 45,527 bytes; 28 manifest cards |
| Mixed, starter 24 | 1,076 / 962 / 1,034 ms | 579,329 bytes; 750 manifest cards |

Background batches took 199–517 ms. Mixed varied across runs (earlier interleaved samples were 674–933 ms); these local measurements alone do not demonstrate subsecond production startup. Deployed measurements follow after release verification.

API `test:loading` retains original complete GraphQL golden fixtures and adds compact HTTP/semantic contracts: owner validation, shape/content, legacy and CLOZE, missing relations, all grading outcomes, custom options/time zones, native pair ordering/allocation/idempotence and extra practice. `test:catalog-cache` covers expiry, database isolation, immutable copies, single-flight failures, invalidation during refresh and partial failed writes. Web `test:study-previews` compares 24 local preview/grade cases against saved authoritative server results across grades, phases, time zones and DST. `test:progressive-study` holds background responses, verifies zero Reveal requests and complete offline Notes/Examples, preserves typing, checks starter exhaustion without false completion and protects newer schedules/burial from stale hydration. Loading/authentication, full learning, Undo/outbox and completion regressions remain in CI.


### Full-response feasibility follow-up

The user prefers one complete lean response when it is fast enough. An initial production compact comparison exposed duplicate `items` and `manifest`: full Words was 1,395,495 bytes/2,271 ms (751 cards), while the 24-card starter was 577,225 bytes/1,399 ms. Phrases full was already 103,060 bytes/663 ms (57 cards); Mixed full was 1,444,699 bytes/1,492 ms (779 cards). These are individual response-header/body completion samples, not ready-to-play medians.

Full envelopes now omit that duplicate manifest. Partial responses keep it; the browser already supports both. Duplicate per-state item ID/type fields are reconstructed from the outer card identity. Complete card reads project only the seven grading/feedback fields, including all Notes and Examples. Grammar, legacy examples and phrase synonyms use full-result cursor batches of 1,000 to eliminate hidden default-101 `getMore` round trips. Scheduler timestamps and both nested/top-level scheduling values are retained to preserve meaningful differences and Undo snapshots. The normal full queue request omits `cardLimit`, because due/new/learning-ahead totals can exceed the due-only 5,000 limit. These transport cuts do not change selected cards, ordering, scheduling or stored data.

Browser mocks now cover one complete response with no manifest and no background fetches, as well as the optional partial-delivery path. Offline feedback, next-card transitions and reconstructed identity are asserted. Production comparison after deploying this follow-up is required to decide the default delivery strategy.


Guarded local follow-up, full lean response, prewarmed static catalogs, `newLimit:0`, all writes/index changes blocked:

| Full response | Three samples | JSON / selected items |
| --- | --- | --- |
| Words | 964 / 787 / 566 ms | 763,886 bytes / 722 |
| Phrases | 299 / 320 / 302 ms | 26,089 bytes / 28 |
| Mixed | 574 / 586 / 581 ms | 789,409 bytes / 750 |

All full envelopes have zero manifest rows. Words/Phrases/Mixed use 8/5/9 database commands with no `getMore`. Mocked complete queue order, checking/feedback fields and every scheduling transition stay equivalent to the compatible GraphQL response. The later pending-word read is intentionally retained: another device can create or Undo-restore a NEW card after initial selection, so reusing an earlier snapshot would weaken current concurrency behavior.
