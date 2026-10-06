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


### Production verification of complete lean delivery

API `ae2122a` and Web `ba74886` were verified live on the existing OVH/Cloudflare production origins. Cloudflare's Git build published assets byte-identical to the locally tested Cloudflare build; the local Wrangler deployment lacked credentials, so no manual CLI release was used. Main CI checks run independently. No production answers/ratings were submitted.

With the real account allowance `newLimit:40`, complete HTTP response samples were Words 1,938 / 1,338 / 1,244 ms (751 cards, 800,380 bytes), Phrases 468 / 437 / 447 ms (57 cards, 53,903 bytes), and Mixed 1,765 / 1,248 / 1,341 ms (779 cards, 825,903 bytes). All returned HTTP 200, zero manifest rows, complete Notes/Examples/accepted answers and no relation objects, server review previews or duplicate state identities. Headers dominated elapsed time, so the remaining word/mixed cost is backend work rather than downloading the final text. The full response is feasible and substantially smaller, but this revision does not yet meet the one-second word/mixed target.

Clearing HTTP and derivative study caches, disabling HTTP caching and hard-reloading confirmed the deployed frontend starts normal full queues without `cardLimit` and issues zero background `/cards` calls. One Words click took 1,641 ms (all 751 cached cards hydrated); Phrases took 723 ms, with a 663-ms queue request; Mixed took 1,827 ms, with a 1,756-ms queue request. Their parallel scoped count requests took 873 / 590 / 874 ms. Three Dashboard reloads took 1,587 / 1,175 / 1,217 ms; Dashboard API requests took 887 / 807 / 860 ms, and token validation 268 / 249 / 307 ms. Every observed request was HTTP 200, without disk-cache or service-worker responses. These are intermediate measurements; further selection optimization follows.


### Fresh pending/prerequisite reads without repeated rich state

Compact word/mixed entry now probes fresh pending card identities first. If every identity, relation and direction is already covered by the initial snapshot and the pending count prevents allocation, the caller would discard those duplicate results; it therefore skips their redundant full scheduling read and inner sibling lookup. Unknown concurrent cards, changed identities and legacy words use the complete original path. The outer prerequisite check stays fresh: a maximum-two missing-ID probe loads zero/one record directly, and falls back to the original unsorted full query for two or more records. This preserves duplicate-direction winner order, learning-ahead order, account ownership and completeness. No user state is retained across requests, no index changes or stored-data reorder are made.

Mocks assert complete/odd/overflow pairs, blocked/future recognition, duplicate directions, absent/null relations, unseen concurrent pending arrivals, late suspended recognition, changed directional identity, cross-type ID collisions and both original winner orders when two missing recognition records exist. The probe is not a final queue limit. Existing complete GraphQL golden fixtures remain unchanged.

Guarded real-entry audit (`newLimit:40`, static catalogs prewarmed, every write/index change blocked) returned Words 1,106 / 866 / 796 ms (747 cards, 795,733 bytes), Mixed 727 / 688 / 684 ms (775 cards, 821,256 bytes), and Phrases 312 / 313 / 304 ms (57 cards, 53,903 bytes). Words uses nine database commands rather than ten, with zero `getMore`. Pending identity transfer fell from 266,038 to 52,287 bytes; the repeated inner sibling read of 267,215 bytes was removed, and the fresh outer sibling read fell from 267,215 to 1,386 bytes. This avoids approximately 746.8 KB of Mongo response transfer on this entry path while keeping the complete browser response. Account card totals changed during the audit, so these are repeated current measurements rather than a frozen-data A/B comparison. Production verification follows deployment.


### Production selection follow-up and competing count requests

API `5cefa41` passed CI and was verified as the running public HTTPS release. The first direct complete request after restart was Words 2,185 ms and Mixed 1,401 ms; later samples were Words 974 / 994 ms and Mixed 1,019 / 1,034 ms. Phrases was 558 / 436 / 449 ms. Response contents stayed complete and lean: Words 747 cards / 795,733 bytes, Mixed 775 / 821,256 bytes, Phrases 57 / 53,903 bytes; no manifest duplicates or background requests were used. Restart-first samples are retained, rather than excluded from the result.

The cache-cleared UI run was slower with a separate competing count request: Words ready 1,296 ms, queue 1,224 ms, counts 900 ms; Mixed ready 1,675 ms, queue 1,587 ms, counts 950 ms; Phrases ready 750 ms, queue 668 ms, counts 539 ms. Dashboard hard reloads were 1,251 / 1,189 / 1,248 ms, with API requests 946 / 842 / 939 ms and token validation 407 / 231 / 319 ms. HTTP caches were disabled and cleared, derivative study caches removed, and hard reloads transferred assets without disk-cache/service-worker hits. This indicates avoidable contention/duplicated fresh account and scheduling work at study entry; the next revision combines exact counters with the full card response and shares their projected candidate read.


### One complete entry response with exact counters

Normal browser entry and refill now request `includeCounts:true` on `/api/study/queue`, returning only `counts:{new,learning,review}` alongside all lean complete cards. The competing GraphQL count request is removed. For unfiltered sessions, backend selection and counts share a fresh projected candidate union, profile, account allowance and categories within one request; they apply their original due/counter predicates independently. Category sessions retain their original scoped due read and counter snapshot, with shared account/profile/day reads and one combined response. Counter-only future learning and legacy records cannot leak into the queue. Counts retain deck limits, custom learning-ahead, temporary dates, sibling prerequisites and category nullability; they are not derived from selected-card totals. Unseen identities are captured before allocation where necessary, while covered pending NEW cards skip the unused identity/mastery read. Other compact operations and legacy GraphQL response contracts remain compatible; no account state is cached across requests.

Browser mocks require valid nonnegative integer counters, assert one actual entry request and no standalone counter/background requests for a full response, and retain offline Notes/Examples, rating/Undo and false-completion checks. A token changed between response headers and JSON completion rejects the response. API differential mocks compare exact complete queue/content/state and counters across Words/Phrases/Mixed, categories, partial starters, review ceilings, temporary dates, absent/null legacy scheduling, two-hour custom learning-ahead, duplicate recognition, native allocation and concurrent pending arrivals. They also hold the unseen-identity read and assert allocation cannot race ahead of it.

Guarded current-account verification found the exact same queue order/content/state as the original compact queue, and all three counters equaled the existing GraphQL calculation. Union query plans retained the original winning indexes, with 24 / 23 / 3 ms execution for Words / Mixed / Phrases. Combined real-entry samples were Words 1,011 / 977 / 686 ms, Mixed 741 / 780 / 998 ms, and Phrases 301 / 313 / 311 ms. Verification repeats were 990 / 775 / 309 ms respectively. Command counts remain 9 / 10 / 5, equal to queue-alone reads, without duplicate counter/identity snapshots or `getMore` for this account's pending-card path. Every audit write/index change was blocked. Production UI verification follows deployment.


Before release, a populated-category guarded comparison caught a real queue-order mismatch when the category predicate moved out of the Mongo query. The candidate cursor is historically unsorted, so a changed query plan can change ties. That path was not deployed: categorized sessions now retain the original scoped due query and original counter snapshot. Unfiltered sessions retain the shared candidate read; the browser still makes one request in both cases. No physical reordering, new sort semantics or query hints were introduced. Exact category comparisons are repeated after this correction.


After the conservative fallback, guarded exact queue/order/content/state and three-counter comparisons passed for populated `debate` sessions in Words/Phrases/Mixed with positive new allowance, and `university` / `general_vocabulary` in all three modes with `newLimit:0`. A positive-new university audit required catalog allocation and stopped at the write guard before any mutation; native allocation remains covered by mocked contracts. The differing category plans were owner+relation for the original scoped query versus owner+due-date for the union. Category sessions keep the original plan/query behavior rather than depend on new sort/hint semantics.

### Deployed combined complete responses, 6 October 2026

API `8546ad6` passed its complete CI/deployment workflow and public health reported the exact running commit. Web `6579f43` was published by Cloudflare's Git build; its entry asset `index-CONGXPI8.js` was byte-identical to the tested local Cloudflare build (218,655 bytes, SHA-256 `50b2485dc5009a4bdcdcc5e12f65bf9ccb3284d8a57617f3a907e254a19ac235`). The signed-in browser also loaded that entry asset. Each normal Words/Phrases/Mixed entry sent `includeCounts:true`, omitted `cardLimit`, and made exactly one queue request, without standalone count or background-card requests.

Direct complete HTTP samples after the backend restart were Words 1,834 / 957 / 988 ms, Phrases 478 / 445 / 437 ms and Mixed 1,163 / 1,100 / 1,041 ms. The first restart sample remains included. Responses contained 747 / 57 / 775 cards and 795,780 / 53,948 / 821,303 decoded JSON bytes respectively, zero manifest rows, exact three-counter envelopes and complete checking/feedback fields. Account totals changed during this task, so payload comparisons are approximate rather than a frozen-dataset benchmark.

The actual browser trial cleared HTTP and derivative study caches before each Dashboard hard reload and disabled HTTP caching. Primary commands, authentication and preferences were preserved. Every observed response was HTTP 200; assets transferred from the network, without disk-cache or service-worker hits. No production answers or ratings were submitted.

| View / measured boundary | Trials | Fastest | Median | Slowest | API request median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dashboard, reload → loaded layout | 9 | 1,129 ms | 1,260 ms | 1,487 ms | 895 ms |
| Words, click → playable card | 3 | 1,398 ms | 1,435 ms | 1,532 ms | 1,371 ms |
| Phrases, click → playable card | 3 | 680 ms | 690 ms | 799 ms | 573 ms |
| Mixed, click → playable card | 3 | 1,389 ms | 1,420 ms | 1,520 ms | 1,313 ms |

Compared with the original cold UI medians, Words improved by approximately 66%, Mixed 67%, Phrases 38% and Dashboard 19%. Complete lean delivery is feasible; normal entry retains the entire selected session and does not require batches to preserve features. Phrases meets the one-second entry goal. Dashboard API reads are mostly below one second, but whole-page startup and Words/Mixed entry still exceed it. These measurements do not justify claiming all flows are subsecond or reporting only warm direct-request results. Words/Mixed response headers consume almost the whole request; final browser mapping takes roughly 64–157 ms. One inspected Mixed request used an existing HTTP/2 connection, a 19-ms CORS preflight and 1,256-ms response-header wait, so frontend caching/preflight changes alone would not remove the remaining backend cost.

The requested GPT-6.1 Sol / Ultra subagent also probed a conditional counter projection on MongoDB 8.0.34. It kept the original filters/indexes/cursor order, reconstructed legacy fields and matched all five counters across Words/Phrases/Mixed in three scopes. It reduced BSON by 16–22% but repeated warm query timings showed no reliable gain (Words 165 → 174 ms, Mixed 169 → 177 ms, Phrases 123 → 123 ms). That experiment was read-only and was not deployed. No index changes or physical data rearrangement were justified by these results.

A separate interleaved full-versus-24-card production HTTP experiment preserved exact first-card packet contents and all three counters in every comparison. Word full responses took 1,613 / 1,229 / 1,134 ms versus starters 1,188 / 1,465 / 917 ms. Mixed full responses took 1,845 / 2,195 / 2,384 ms versus starters 1,396 / 2,644 / 1,606 ms. Mixed downloads varied substantially during this extra probe; these are direct HTTP experiments, not substitutes for the cold UI table. Starter envelopes still needed 531,281 bytes Words / 552,980 bytes Mixed to preserve full-session scheduling/order metadata, versus 795,780 / 821,303 for full content. Batching therefore did not consistently meet one second or remove the underlying selection cost. The full lean response stays the default, consistent with the requested preference.

### Captured content for complete queues

Unfiltered full requests without an explicit `cardLimit` now project the seven displayed card fields alongside each fresh progress selection read and reuse the final selected card's content. This removes the redundant post-selection progress-content query. Rich relations, append-only history and import metadata remain excluded. New pending arrivals, prerequisite siblings and native conversion results retain complete content in the fresh reads that select them. Each record uses its own captured observation point, matching the original GraphQL flow; this is not a new atomic snapshot or cross-request cache. Explicit partial starters, `/cards` and `/more` retain their existing later content hydration.

The pre-implementation read-only interleaved prototype preserved the entire current compact response, counters and order in every pair. Words was 1,143 / 1,084 / 1,036 ms before versus 1,124 / 849 / 857 ms with captured content (median improvement 227 ms). Mixed was 996 / 1,033 / 1,016 versus 999 / 802 / 808 ms (208 ms improvement). One database command was removed in each case. Total MongoDB BSON increased slightly, Words 1,538,486 → 1,560,628 bytes and Mixed 1,749,555 → 1,770,794 bytes, because some unselected candidates now include those fields. That small transfer cost is outweighed by removing a redundant rich progress read; unselected content is never sent to the browser. All seven card fields matched the original GraphQL response by item ID in Words/Phrases/Mixed. A Word order difference between the old full GraphQL and current compact queries predates this change; the new path preserves current compact ordering exactly.

Mocks cover a content edit during pending checks: complete queues retain the selected snapshot like the original GraphQL response, while optional starters retain their later hydration. They also assert no redundant full-queue content query, complete late pending/sibling/native content, concurrent native conversion, legacy field shapes, original local scheduler state and exact counters. Production verification follows release.


A final guarded categorized comparison found an order-only difference when the selection projection was widened in populated general-vocabulary Words/Mixed sessions: normalized content/state and all three counters matched, without duplicate IDs. Repeated explain outputs listed the same index, so this audit does not attribute the difference to a specific planner choice. Categorized requests therefore keep the original narrow projection and later content hydration. The optimization applies only to unfiltered full requests; every category still receives one complete lean HTTP response with exact counters.

The synthetic read-only MongoDB 8.0 projection probe also exposed a mock fidelity gap: dotted projections retain `{}` for empty/metadata-only card objects and omit missing/null parents. The test helper now follows those observed semantics, and the new captured-card path preserves the exact DTO distinction. No production document was written for this probe.


### Captured-content release verification and browser variability

API `e6aa97a` passed the full verification/deployment workflow, and public HTTPS health reported that exact release. Complete direct HTTP trials remained HTTP 200 with the same 747 / 57 / 775 cards, 795,780 / 53,948 / 821,303 decoded bytes, all three counters, zero manifests and complete accepted answers/Notes/Examples. Words took 1,895 / 1,237 / 2,162 ms; Phrases 505 / 481 / 962 ms; Mixed 1,244 / 1,395 / 1,274 ms. Words response headers arrived in 1,525 / 909 / 1,078 ms, showing that variable body delivery also affected these samples. This release removes one database command, but those HTTP samples do not establish a consistent production latency gain.

A fresh signed-in Chrome tab loaded the same tested `index-CONGXPI8.js`. Each trial cleared HTTP and derivative study caches, kept HTTP caching disabled and reloaded the Dashboard before entering a session. Authentication, preferences and primary command storage were preserved. These were complete queue responses with `includeCounts:true`, no `cardLimit`, no standalone count request and no background-card request. Observed application responses were HTTP 200 without disk-cache/service-worker hits; CORS preflights were HTTP 204. No answers/ratings were submitted.

| Boundary | UI-ready samples (ms) | Application request samples (ms) |
| --- | --- | --- |
| Dashboard hard reload | 1,885 / 3,189 / 1,328 / 1,934 / 1,459 | 860 / 830 / 854 / 867 / 868 |
| Words click | 4,072 / 2,009 | 1,391 / 1,425 |
| Phrases click | 2,130 / 4,206 | 691 / 676 |
| Mixed click | 2,095 | 2,002 |

All completed samples are retained. The initial measurement runner lost its browser attachment; its unfinished run is not counted. Browser measurements subsequently encountered navigation/control timeouts. Local process samples also showed substantial concurrent security scanning and other CPU work. Browser entries attributed long work both to response processing (1,322 ms) and React rendering (1,321 ms, including 478 ms forced style/layout). Host contention may contribute, but these observations do not prove its exact causal share. The later browser timings are therefore reported separately from the earlier stable cold table; they are not substituted with a best-case number. Normal browser caching was restored and the temporary measurement tab closed. The one-second UI target is not guaranteed.


### Fresh profile/account overlap at the queue boundary

Default HTTP study-queue requests now verify the JWT locally before starting the fresh scheduler-profile lookup alongside the fresh account lookup. A real authenticated account must resolve before selection, counters, allowances or native allocation begins. The exact owner-matched profile Promise, including an absent profile, seeds the existing request-only metadata map and is reused by both queue and counters. No authorization, account, quota or profile state is cached across requests. Selection/counter timestamps remain captured after account authentication. Injected authentication and `/cards` / `/more` retain their original paths.

The profile is observed earlier within this request. A concurrent profile edit during the account lookup may be reflected on the next request rather than this one; the old account/profile reads were not an atomic snapshot either. Account settings still come from the fresh authenticated account and override profile defaults. This observation change is explicit and mocked, rather than hidden as an unchanged concurrency guarantee.

Build, loading, authentication and immutable-catalog-cache tests pass. HTTP mocks compare the entire complete response and exact counters with the sequential authenticated baseline. Held account reads prove the profile starts independently while every study read/write remains behind successful authentication. Cases include signature/expiry/claim rejection before Mongo reads, deleted accounts (including a concurrent profile failure) returning 401, account/profile failures returning 503 without orphaned rejections, missing profiles read exactly once, account settings changed during auth, profile edits visible freshly on the next request, uppercase ObjectId JWT claims, foreign-owner metadata rejection and unchanged injected/other-endpoint paths. Held-read tests have bounded native timers and always release their gates. An independent source review found no substantive issue. Production verification follows deployment.

API `887210b` passed the complete CI/deployment workflow and public health confirmed the exact release. Completed signed-in, cache-cleared hard-reload trials loaded the tested Cloudflare entry asset and retained complete `includeCounts:true` requests without `cardLimit`, standalone counters or background-card requests. Dashboard ready times were 1,410 / 1,322 / 1,060 ms (Dashboard API 1,002 / 840 / 735 ms; fresh Me validation 317 / 234 / 346 ms). One completed entry per mode was Words 1,787 ms (API 1,635), Phrases 542 ms (API 480), Mixed 1,713 ms (API 1,644). A further multi-trial browser-control call timed out; unfinished measurements are excluded. These completed trials alone do not establish a repeatable word/mixed improvement or satisfy the one-second UI goal.

Two subsequent interleaved direct full-response rounds on the same release returned Words 1,514 / 1,476 ms, Phrases 485 / 378 ms, Mixed 1,030 / 942 ms. Their respective response-header times were 1,471 / 1,433, 366 / 377 and 978 / 901 ms. All six HTTP 200 packets had the same 747 / 57 / 775 cards, 795,780 / 53,948 / 821,303 decoded bytes, one distinct scheduling profile, exact counters, zero manifests and complete feedback. Each mode's entire JSON packet was byte-identical across the two rounds. These direct requests are reported separately from click-to-card timings; no production answers or ratings were submitted.

Inspection of these packets found 21 legacy Word cards in both Words and Mixed. Their global vocabulary Notes/Examples still required fresh post-selection reads, alongside German grammar and phrase synonyms. Removing only grammar/synonym reads would reduce commands but retain that final round trip in both Word modes. The next revision reuses the existing bounded static catalog snapshot for those shared display fields too, while retaining fresh per-user progress/card content and the complete selected-card whitelist.

### Reuse shared display and legacy feedback snapshots

The same six immutable catalog parts now include only the displayed German word categories/forms, German phrase synonyms, German dictionary Notes/Examples and Spanish dictionary examples. Queue assembly uses the selected relation endpoints already loaded for text instead of repeating late dictionary reads. Full Words removes three parallel commands, Phrases one, Mixed four; the final display round trip is removed. Explicit partial/category/cards/more paths retain their fresh per-user progress-card hydration and original category ID lookups. No new cache, timer, collection, index or sort order is introduced. The browser's complete DTO whitelist and counts are unchanged, and it never receives unselected catalog documents.

These global dictionary fields now share text's existing immutable observation contract: refresh every 15 seconds, hard expiry at 30 seconds, with in-process catalog writes invalidating immediately. Per-user card Notes/Examples, progress, scheduling profiles, account validation and quotas stay fresh. Native allocation still reads its full dictionary input freshly; enriched synthetic counter pairing cannot alter scheduling/selection. The reviewed/emergency LEXEME writer had an existing invalidation gap; it now invalidates in finally before session cleanup, including transaction rejection, uncertain commit and cleanup failure. SURFACE-only translation saves retain the catalog generation.

Build, authentication, loading and catalog-cache checks pass. Mocked complete/partial/category/background responses match the compatible GraphQL content, state, ordered IDs and exact counters in all three modes. Missing/null/empty grammar, synonyms and legacy feedback retain their original shape; explicit cards do not duplicate dictionary feedback. Mocks verify fresh per-card content/version/mistake state during external catalog edits, bounded shared-field refresh/invalidation, immutable nested display arrays/forms, database isolation, expiry and generation-safe refresh. A mocked LEXEME writer regression first reproduced stale generations, then passed for success and every error outcome; its held work has a three-second timeout. Production full-packet and cold UI verification follows deployment.

The final independent review found no substantive blocker. Legacy dictionary feedback remains restricted to records classified legacy at selection, preserving the old optional late-hydration behavior if another device removes an explicit card while it loads; a new mocked removal case passes. All required local checks were repeated after that guard. The deliberate tradeoff is a larger server-only static vocabulary snapshot with bounded staleness, rather than an extra dictionary round trip per session. Browser packet contents remain unchanged.

### Feature-driven transport decision

| Delivered fields | Actual study feature requiring them |
| --- | --- |
| IDs, type, directional prompt/answer, accepted answers, German/Spanish text | Recognition/typing, phrase tiles and distractors, answer checking, owned synchronization |
| Card Notes/Examples; legacy dictionary feedback; article/categories and displayed verb forms; phrase synonyms | Existing Reveal/Check feedback, translated examples, noun capitalization/article checking and alternate phrase answers, all available without hydration requests |
| Sibling note identity | Recognition-before-typing and local sibling burial/restoration |
| Category contexts and failure total | Scoped counter projection of durable commands and correct mistake replay across routes |
| Versioned scheduling state, fuzz seed, calendar/time zone, learning phase/step and review history inputs | Exact locally generated ratings/delays, repeated learning, custom settings, leech behavior, Undo and conflict-safe synchronization |
| Deduplicated settings profiles; new/learning/review counters | One shared settings value per distinct profile, accurate session progress/completion and refill decisions |

Relation objects/IDs, archive/import metadata, unused dictionary forms, append-only history, duplicated full-session manifests and server-generated rating previews are excluded. A due date alone cannot reproduce the existing scheduler: two cards due at the same instant can have different learning phases, steps, intervals, ease, lapses, calendar boundaries and custom options. The browser computes previews only for the active revealed card. Its source audit found that contexts are used by scoped durable-counter replay, rather than decorative metadata.

The indexed due predicates themselves take milliseconds in the guarded query-plan audit. Entry also validates a fresh account, applies fresh daily allowances, selects ordered learning/new/review cards, enforces directional prerequisites and concurrent-device arrivals, and reads complete selected feedback. Serial database round trips and prior duplicate transfers accounted for much more time than the date filter. Physical document insertion/retrieval rearrangement has no demonstrated benefit here; it can change unsorted tie order, which two guarded experiments actually caught. Existing scoped queries/index behavior are retained. Complete lean delivery is viable and remains the default; the measured starter fallback did not consistently meet one second and is unnecessary to preserve study features.

### Deployed shared-feedback verification and final complete-delivery assessment

API `c79e2b1` passed every verification/deployment check; uncached public health confirmed the exact running commit `c79e2b1e93a91682b387d566be93368fc6ca06f5`. Web `6579f43` remained the tested, published Cloudflare build with entry asset `index-CONGXPI8.js`.

Three interleaved direct full-response rounds returned Words 1,595 / 1,402 / 1,476 ms, Phrases 285 / 1,048 / 411 ms, Mixed 969 / 1,311 / 904 ms. Their response-header times were respectively 1,556 / 1,361 / 1,436; 284 / 1,038 / 276; 924 / 1,269 / 861 ms. Every whole JSON packet exactly matched its pre-deployment `887210b` baseline, including all item fields, ordering, scheduling state, counters and feedback. All were HTTP 200 with 747 / 57 / 775 cards, 795,780 / 53,948 / 821,303 decoded bytes, one profile, zero manifests, `remaining:0` and `complete:true`. Private packet contents remained inside the signed-in browser and were removed during cleanup. These timings do not show a reliable large direct-request gain; command removal is independently verified below.

The following actual UI trials each cleared HTTP and derivative card caches, disabled HTTP caching and hard-reloaded the Dashboard before clicking the mode. Authentication, preferences and primary commands were preserved. Five observed application assets per reload transferred without disk-cache or service-worker hits. All observed application responses were HTTP 200. Full entry requests included exact counters, omitted `cardLimit`, and retained zero background-card or separate count calls. No production answers/ratings were submitted.

| Boundary | Trials | Fastest | Median | Slowest | Application request median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dashboard reload → observed loaded layout | 9 | 940 ms | 1,184 ms | 1,646 ms | 822 ms |
| Words click → playable card | 3 | 995 ms | 1,269 ms | 1,738 ms | 1,157 ms |
| Phrases click → playable card | 3 | 462 ms | 642 ms | 796 ms | 506 ms |
| Mixed click → playable card | 3 | 1,052 ms | 1,164 ms | 1,363 ms | 1,089 ms |

Raw Dashboard ready samples: 1,646 / 1,207 / 1,310 / 1,084 / 1,259 / 1,184 / 960 / 1,018 / 940 ms. Dashboard API: 944 / 822 / 805 / 885 / 957 / 851 / 790 / 764 / 775 ms. Me validation: 422 / 395 / 295 / 277 / 337 / 236 / 368 / 282 / 415 ms. Words ready/API: 1,738/1,446, 995/945, 1,269/1,157 ms. Phrases: 796/562, 642/506, 462/377. Mixed: 1,363/1,203, 1,052/968, 1,164/1,089. The first retained trial reported a truncated network-event buffer, although its Dashboard/Me/queue and five assets were captured; the remaining eight reported complete buffers. Assertions about absent extra requests are supported by those complete captures and browser regressions. Dashboard readiness is observed immediately after reload instrumentation attaches, so it is an upper-bound observation rather than a trace-derived render timestamp. All completed trial values remain included.

A separate guarded same-account database audit, with catalogs prewarmed and `newLimit:40`, blocked all writes/index changes. Complete Words took 791 ms with five database commands, Phrases 228 ms with three, Mixed 723 ms with five; zero `getMore` and identical full packet sizes. Account authentication was excluded from these internal queue timings. Words transferred 1,432,198 BSON bytes for 973 fresh candidates (343 ms), 52,287 for the pending identity scout (207 ms) and 1,815 for the final fresh sibling probe (115 ms); profile and daily-count reads were 105/100 ms. Mixed candidates were 1,635,041 bytes / 1,224 rows (445 ms), pending scout 53,766 / 274 (121 ms), sibling probe 1,815 / 1 (111 ms), profile/daily counts 95/100 ms. Phrases used its candidates plus profile and daily counts only. This confirms the late dictionary commands are removed. The bounded read-only audit overlapped the second Words UI trial; its timing remains included and is not treated as an isolated benchmark.

Full lean delivery passes the feasibility and feature-preservation tests and stays the default. Approximate cold-median improvements from the original audit are Words 70%, Mixed 73%, Phrases 42% and Dashboard 24%; account totals and network/browser conditions changed, so these are operational before/after measurements rather than a frozen-data A/B test. Phrases is consistently below one second in this cold UI series. Dashboard's API requests are below one second, but complete startup and Words/Mixed entry do not consistently meet that goal. The retained full response is acceptable as a major improvement, not evidence of a universal subsecond guarantee.

Further tested counter/default-options projections did not reliably improve latency. Moving the final prerequisite probe earlier or reusing old pending state would weaken concurrent-device behavior; the selection predicates and observation points are therefore retained. No further safe query rewrite is justified by this audit. Remaining cost is fresh candidate transfer, required sequential selection checks, account validation and network/browser variability. A stronger latency guarantee would need a separate measured infrastructure or concurrency-contract change, rather than physical document rearrangement or stripping required feedback. Browser cache controls and temporary instrumentation were restored/removed after measurement. The canonical diagram records these flows while retaining its original dated inventory counts.
