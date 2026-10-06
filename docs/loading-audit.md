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
